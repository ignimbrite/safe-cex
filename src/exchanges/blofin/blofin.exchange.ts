import type { Axios } from 'axios';
import chunk from 'lodash/chunk';
import flatten from 'lodash/flatten';
import partition from 'lodash/partition';
import times from 'lodash/times';
import uniqBy from 'lodash/uniqBy';
import { map } from 'p-iteration';

import type { Store } from '../../store/store.interface';
import { OrderSide, OrderStatus, OrderType, PositionSide } from '../../types';
import type {
  ExchangeOptions,
  Market,
  Position,
  Ticker,
  Order,
  OHLCVOptions,
  Candle,
  PlaceOrderOpts,
  UpdateOrderOpts,
  Writable,
  OrderBook,
} from '../../types';
import { inverseObj } from '../../utils/inverse-obj';
import { omitUndefined } from '../../utils/omit-undefined';
import { roundUSD } from '../../utils/round-usd';
import { adjust, divide, multiply, subtract } from '../../utils/safe-math';
import { BaseExchange } from '../base';

import { createAPI } from './blofin.api';
import {
  ENDPOINTS,
  INTERVAL,
  ORDER_SIDE,
  ORDER_STATUS,
  ORDER_TYPE,
} from './blofin.types';
import { BlofinPrivateWebsocket } from './blofin.ws-private';
import { BlofinPublicWebsocket } from './blofin.ws-public';

export class BlofinExchange extends BaseExchange {
  xhr: Axios;

  publicWebsocket: BlofinPublicWebsocket;
  privateWebsocket: BlofinPrivateWebsocket;

  leverageHash: Record<string, number> = {};

  constructor(opts: ExchangeOptions, store: Store) {
    super(opts, store);

    this.xhr = createAPI(opts);
    this.publicWebsocket = new BlofinPublicWebsocket(this);
    this.privateWebsocket = new BlofinPrivateWebsocket(this);
  }

  getAccount = async () => {
    const { data } = await this.xhr.get(ENDPOINTS.API_KEY);
    const { apiKey, referralCode } = data.data;

    return { userId: apiKey, affiliateId: referralCode };
  };

  validateAccount = async () => {
    try {
      const { data } = await this.xhr.get(ENDPOINTS.API_KEY);

      if (data?.code !== '0') return data?.msg;
      if (data?.data?.readOnly === 0) return '';

      return 'Invalid API key, secret or passphrase';
    } catch (err) {
      return 'Invalid API key, secret or passphrase';
    }
  };

  dispose = () => {
    super.dispose();
  };

  start = async () => {
    const markets = await this.fetchMarkets();
    if (this.isDisposed) return;

    this.store.update({
      markets,
      loaded: { ...this.store.loaded, markets: true },
    });

    const tickers = await this.fetchTickers();
    if (this.isDisposed) return;

    this.log(
      `Loaded ${Math.min(tickers.length, markets.length)} Blofin markets`
    );

    this.store.update({
      tickers,
      loaded: { ...this.store.loaded, tickers: true },
    });

    await this.fetchLeverage();

    const [balance, positions] = await Promise.all([
      this.fetchBalance(),
      this.fetchPositions(),
    ]);

    this.store.update({
      positions,
      balance: {
        ...balance,
        upnl: positions.reduce((acc, p) => acc + p.unrealizedPnl, balance.upnl),
      },
      loaded: {
        ...this.store.loaded,
        balance: true,
        positions: true,
      },
    });

    this.publicWebsocket.connectAndSubscribe();
    this.privateWebsocket.connectAndSubscribe();

    this.log(`Ready to trade on Blofin`);

    const orders = await this.fetchOrders();
    if (this.isDisposed) return;

    this.log(`Loaded ${orders.length} Blofin orders`);

    this.store.update({
      orders,
      loaded: { ...this.store.loaded, orders: true },
    });
  };

  fetchBalance = async () => {
    try {
      const {
        data: { data },
      } = await this.xhr.get<{ data: Record<string, any> }>(ENDPOINTS.BALANCE);

      const usdt = data.details.find((d: any) => d.currency === 'USDT');

      if (usdt) {
        const total = parseFloat(usdt.balance);
        const free = parseFloat(usdt.available);
        const used = subtract(total, free);
        this.store.update({ balance: { total, free, used, upnl: 0 } });
      }

      return this.store.balance;
    } catch (err: any) {
      this.emitter.emit('error', err?.response?.data?.msg || err?.message);
      return this.store.balance;
    }
  };

  fetchMarkets = async () => {
    try {
      const {
        data: { data },
      } = await this.xhr.get<{ data: Array<Record<string, any>> }>(
        ENDPOINTS.MARKETS
      );

      const markets: Market[] = data
        .filter((m) => m.contractType === 'linear')
        .map((m) => {
          const maxAmount = Math.min(
            parseFloat(m.maxMarketSize),
            parseFloat(m.maxLimitSize)
          );

          return {
            id: m.instId,
            symbol: m.instId.replace(/-/g, ''),
            base: m.baseCurrency,
            quote: m.quoteCurrency,
            active: m.state === 'live',
            precision: {
              amount: parseFloat(m.contractValue),
              price: parseFloat(m.tickSize),
            },
            limits: {
              amount: {
                min: parseFloat(m.minSize) * parseFloat(m.contractValue),
                max: maxAmount,
              },
              leverage: {
                min: 1,
                max: parseFloat(m.maxLeverage),
              },
            },
          };
        });

      return markets;
    } catch (err: any) {
      this.emitter.emit('error', err?.response?.data?.msg || err?.message);
      return this.store.markets;
    }
  };

  fetchTickers = async () => {
    try {
      const {
        data: { data },
      } = await this.xhr.get<{ data: Array<Record<string, any>> }>(
        ENDPOINTS.TICKERS
      );

      const tickers: Ticker[] = data.reduce(
        (acc: Ticker[], t: Record<string, any>) => {
          const market = this.store.markets.find((m) => m.id === t.instId);

          if (!market) return acc;

          const open = parseFloat(t.open24h);
          const last = parseFloat(t.last);
          const percentage = roundUSD(((last - open) / open) * 100);

          const ticker = {
            id: market.id,
            symbol: market.symbol,
            bid: parseFloat(t.bidPrice),
            ask: parseFloat(t.askPrice),
            last,
            mark: last,
            index: last,
            percentage,
            fundingRate: 0,
            volume: parseFloat(t.volCurrency24h),
            quoteVolume: parseFloat(t.vol24h),
            openInterest: 0,
          };

          return [...acc, ticker];
        },
        []
      );

      return tickers;
    } catch (err: any) {
      this.emitter.emit('error', err?.response?.data?.msg || err?.message);
      return this.store.tickers;
    }
  };

  fetchLeverage = async () => {
    try {
      const responses = flatten(
        await map(chunk(this.store.markets, 20), async (batch) => {
          if (this.isDisposed) return [];

          const {
            data: { data },
          } = await this.xhr.get(ENDPOINTS.LEVERAGE, {
            params: {
              instId: batch.map((m) => m.id).join(','),
              marginMode: 'cross',
            },
          });

          return data;
        })
      );

      if (!this.isDisposed) {
        responses.forEach((r: Record<string, any>) => {
          this.leverageHash[r.instId] = parseFloat(r.lever);
        });
      }
    } catch (err: any) {
      this.emitter.emit('error', err?.response?.data?.msg || err?.message);
    }
  };

  fetchPositions = async () => {
    const {
      data: { data },
    } = await this.xhr.get<{ data: Array<Record<string, any>> }>(
      ENDPOINTS.POSITIONS
    );

    const positions: Position[] = this.mapPositions(data);
    const fakePositions = this.store.markets.reduce((acc: Position[], m) => {
      const hasPosition = positions.some((p) => p.symbol === m.symbol);
      if (hasPosition) return acc;

      const fakeMarketPositions: Position = {
        symbol: m.symbol,
        side: PositionSide.Long,
        entryPrice: 0,
        notional: 0,
        leverage: this.leverageHash[m.id] || 1,
        unrealizedPnl: 0,
        contracts: 0,
        liquidationPrice: 0,
      };

      return [...acc, fakeMarketPositions];
    }, []);

    return [...positions, ...fakePositions];
  };

  fetchOrders = async () => {
    const orders = await this.fetchNormalOrders();
    const algoOrders = await this.fetchAlgoOrders();
    return [...orders, ...algoOrders];
  };

  fetchNormalOrders = async () => {
    const recursiveFetch = async (
      orders: Array<Record<string, any>> = []
    ): Promise<Array<Record<string, any>>> => {
      const {
        data: { data },
      } = await this.xhr.get<{ data: Array<Record<string, any>> }>(
        ENDPOINTS.UNFILLED_ORDERS,
        {
          params: {
            limit: 100,
            after: orders.length
              ? orders[orders.length - 1].orderId
              : undefined,
          },
        }
      );

      if (data.length === 100) {
        return await recursiveFetch([...orders, ...data]);
      }

      return [...orders, ...data];
    };

    const blofinOrders = await recursiveFetch();
    const orders = this.mapOrders(blofinOrders);

    return orders;
  };

  fetchAlgoOrders = async () => {
    const recursiveFetch = async (
      orders: Array<Record<string, any>> = []
    ): Promise<Array<Record<string, any>>> => {
      const {
        data: { data },
      } = await this.xhr.get<{ data: Array<Record<string, any>> }>(
        ENDPOINTS.UNFILLED_ALGO_ORDERS,
        {
          params: {
            limit: 100,
            after: orders.length
              ? orders[orders.length - 1].orderId
              : undefined,
          },
        }
      );

      if (data.length === 100) {
        return await recursiveFetch([...orders, ...data]);
      }

      return [...orders, ...data];
    };

    const blofinOrders = await recursiveFetch();
    const orders = this.mapOrders(blofinOrders);

    return orders;
  };

  fetchOHLCV = async (opts: OHLCVOptions) => {
    const interval = INTERVAL[opts.interval];
    const market = this.store.markets.find((m) => m.symbol === opts.symbol);

    if (!market) {
      this.emitter.emit('error', `Market ${opts.symbol} not found on Blofin`);
      return [];
    }

    try {
      const {
        data: { data },
      } = await this.xhr.get(ENDPOINTS.KLINE, {
        params: {
          instId: market?.id,
          bar: interval,
          limit: 300,
        },
      });

      const candles: Candle[] = data.map((c: string[]) => {
        return {
          timestamp: parseInt(c[0], 10) / 1000,
          open: parseFloat(c[1]),
          high: parseFloat(c[2]),
          low: parseFloat(c[3]),
          close: parseFloat(c[4]),
          volume: parseFloat(c[5]),
        };
      });

      candles.sort((a, b) => a.timestamp - b.timestamp);

      return candles;
    } catch (err: any) {
      this.emitter.emit('error', err?.response?.data?.msg || err?.message);
      return [];
    }
  };

  listenOHLCV = (opts: OHLCVOptions, callback: (candle: Candle) => void) => {
    return this.publicWebsocket.listenOHLCV(opts, callback);
  };

  listenOrderBook = (
    symbol: string,
    callback: (orderBook: OrderBook) => void
  ) => {
    return this.publicWebsocket.listenOrderBook(symbol, callback);
  };

  setLeverage = async (symbol: string, inputLeverage: number) => {
    const market = this.store.markets.find((m) => m.symbol === symbol);
    if (!market) throw new Error(`Market ${symbol} not found on Blofin`);

    const leverage = Math.min(
      Math.max(inputLeverage, market.limits.leverage.min),
      market.limits.leverage.max
    );

    await this.xhr.post(ENDPOINTS.SET_LEVERAGE, {
      instId: market.id,
      leverage: `${leverage}`,
      marginmode: 'cross',
    });

    this.leverageHash[market.id] = leverage;
    this.store.updatePositions([
      [{ symbol, side: PositionSide.Long }, { leverage }],
      [{ symbol, side: PositionSide.Short }, { leverage }],
    ]);
  };

  cancelOrders = async (orders: Order[]) => {
    const [algoOrders, normalOrders] = partition(orders, (o) =>
      this.isAlgoOrder(o.type)
    );

    if (normalOrders.length) await this.cancelNormalOrders(normalOrders);
    if (algoOrders.length) await this.cancelAlgoOrders(algoOrders);
  };

  cancelSymbolOrders = async (symbol: string) => {
    const orders = this.store.orders.filter((o) => o.symbol === symbol);
    await this.cancelOrders(orders);
  };

  placeOrder = async (opts: PlaceOrderOpts) => {
    if (this.isAlgoOrder(opts.type)) {
      const payload = this.formatAlgoOrder(opts);
      return await this.placeAlgoOrder(payload);
    }

    const payloads = this.formatNormalOrder(opts);
    return await this.placeOrderBatch(payloads);
  };

  placeOrders = async (opts: PlaceOrderOpts[]) => {
    const [algoOrders, normalOrders] = partition(opts, (o) =>
      this.isAlgoOrder(o.type)
    );

    const algoOrdersOpts = algoOrders.map((o) => this.formatAlgoOrder(o));
    const normalOrdersOpts = normalOrders.flatMap((o) =>
      this.formatNormalOrder(o)
    );

    const normalOrdersIds = await this.placeOrderBatch(normalOrdersOpts);
    const algoOrdersIds = await map(algoOrdersOpts, (o) =>
      this.placeAlgoOrder(o)
    );

    return [...normalOrdersIds, ...algoOrdersIds];
  };

  updateOrder = async ({ order, update }: UpdateOrderOpts) => {
    const market = this.store.markets.find((m) => m.symbol === order.symbol);
    if (!market) throw new Error(`Market ${order.symbol} not found on Blofin`);

    const newOrder: Writable<PlaceOrderOpts> = {
      symbol: order.symbol,
      side: order.side,
      type: order.type,
      price: order.price,
      amount: order.amount,
      reduceOnly: order.reduceOnly,
    };

    if ('price' in update) newOrder.price = update.price;
    if ('amount' in update) newOrder.amount = update.amount;

    await this.cancelOrders([order]);
    return await this.placeOrder(newOrder);
  };

  mapPositions = (data: Array<Record<string, any>>) => {
    return data.reduce((acc: Position[], p: Record<string, any>) => {
      const market = this.store.markets.find((m) => m.id === p.instId);
      if (!market) return acc;

      const pos = parseFloat(p.positions);
      const contracts = pos ? multiply(pos, market.precision.amount) : 0;

      const side = contracts > 0 ? PositionSide.Long : PositionSide.Short;

      const position: Position = {
        symbol: market.symbol,
        side,
        entryPrice: contracts ? parseFloat(p.averagePrice) : 0,
        notional: contracts ? Math.abs(contracts) * parseFloat(p.markPrice) : 0,
        leverage: parseFloat(p.leverage) || this.leverageHash[p.instId] || 1,
        unrealizedPnl: contracts
          ? adjust(parseFloat(p.unrealizedPnl), market.precision.price)
          : 0,
        contracts: Math.abs(contracts),
        liquidationPrice: p.liquidationPrice
          ? parseFloat(p.liquidationPrice)
          : 0,
      };

      return [...acc, position];
    }, []);
  };

  mapOrders = (orders: Array<Record<string, any>>) => {
    return orders.reduce<Order[]>((acc, o: Record<string, any>) => {
      const market = this.store.markets.find((m) => m.id === o.instId);
      if (!market) return acc;

      const tmpOrders: Order[] = [];

      if (o.tpTriggerPrice) {
        tmpOrders.push({
          id: `${o.tpslId}_tp`,
          status: OrderStatus.Open,
          symbol: market.symbol,
          type: OrderType.TakeProfit,
          side: ORDER_SIDE[o.side],
          price: parseFloat(o.tpTriggerPrice),
          amount: 0,
          filled: 0,
          remaining: 0,
          reduceOnly: true,
        });
      }

      if (o.slTriggerPrice) {
        tmpOrders.push({
          id: `${o.tpslId}_sl`,
          status: OrderStatus.Open,
          symbol: market.symbol,
          type: OrderType.StopLoss,
          side: ORDER_SIDE[o.side],
          price: parseFloat(o.slTriggerPrice),
          amount: 0,
          filled: 0,
          remaining: 0,
          reduceOnly: true,
        });
      }

      if (o.orderId && o.orderCategory === 'normal') {
        const amount = multiply(parseFloat(o.size), market.precision.amount);
        const filled = multiply(
          parseFloat(o.filledSize),
          market.precision.amount
        );

        const remaining = subtract(amount, filled);

        tmpOrders.push({
          id: o.orderId,
          status: ORDER_STATUS[o.state],
          symbol: market.symbol,
          type: ORDER_TYPE[o.orderType],
          side: ORDER_SIDE[o.side],
          price: parseFloat(o.price),
          amount,
          filled,
          remaining,
          reduceOnly: o.reduceOnly === 'true',
        });
      }

      return [...acc, ...tmpOrders];
    }, []);
  };

  private placeOrderBatch = async (payloads: Array<Record<string, any>>) => {
    try {
      const { data } = await this.xhr.post<Record<string, any>>(
        ENDPOINTS.PLACE_ORDERS,
        payloads
      );

      if (data.code !== '0') {
        this.emitter.emit('error', data.msg);
        return [];
      }

      return data.data.reduce((acc: string[], o: Record<string, any>) => {
        return [...acc, o.orderId];
      }, []);
    } catch (err: any) {
      this.emitter.emit('error', err?.response?.data?.msg || err?.message);
      return [];
    }
  };

  private placeAlgoOrder = async (payload: Record<string, any>) => {
    try {
      const { data } = await this.xhr.post(ENDPOINTS.PLACE_ALGO_ORDER, payload);

      if (data.code !== '0') {
        this.emitter.emit('error', data.msg);
        return [];
      }

      return [data.tpslId];
    } catch (err: any) {
      this.emitter.emit('error', err?.response?.data?.msg || err?.message);
      return [];
    }
  };

  private cancelNormalOrders = async (orders: Order[]) => {
    try {
      const ids = orders.map((o) => ({ orderId: o.id }));
      const { data } = await this.xhr.post(ENDPOINTS.CANCEL_ORDERS, ids);

      if (data.code !== '0') {
        this.emitter.emit('error', data.msg);
      }
    } catch (err: any) {
      this.emitter.emit('error', err?.response?.data?.msg || err?.message);
    }
  };

  private cancelAlgoOrders = async (orders: Order[]) => {
    try {
      const ids = uniqBy(
        orders.map((o) => ({
          tpslId: o.id.replace('_sl', '').replace('_tp', ''),
        })),
        'tpslId'
      );

      const { data } = await this.xhr.post(ENDPOINTS.CANCEL_ALGO_ORDERS, ids);

      if (data.code !== '0') {
        this.emitter.emit('error', data.msg);
      }
    } catch (err: any) {
      this.emitter.emit('error', err?.response?.data?.msg || err?.message);
    }
  };

  private formatNormalOrder = (opts: PlaceOrderOpts) => {
    const market = this.store.markets.find((m) => m.symbol === opts.symbol);
    if (!market) throw new Error(`Market ${opts.symbol} not found on Blofin`);

    const maxSize = market.limits.amount.max;
    const pPrice = market.precision.price;

    const pFactor = market.precision.amount;
    const pAmount = divide(pFactor, pFactor);

    const amount = adjust(divide(opts.amount, pFactor), pAmount);
    const price = opts.price ? adjust(opts.price, pPrice) : null;

    const req: Record<string, any> = omitUndefined({
      instId: market.id,
      marginMode: 'cross',
      side: inverseObj(ORDER_SIDE)[opts.side],
      orderType: opts.type,
      price: opts.type === OrderType.Limit ? `${price}` : undefined,
      size: `${amount}`,
      reduceOnly: opts.reduceOnly ? 'true' : 'false',
    });

    if (opts.stopLoss) {
      req.slTriggerPrice = `${price}`;
      req.slOrderPrice = `-1`;
    }

    if (opts.takeProfit) {
      req.tpTriggerPrice = `${price}`;
      req.tpOrderPrice = `-1`;
    }

    const lots = amount > maxSize ? Math.ceil(amount / maxSize) : 1;
    const rest = amount > maxSize ? adjust(amount % maxSize, pAmount) : 0;

    const lotSize = adjust((amount - rest) / lots, pAmount);
    const payloads = times(lots, () => {
      return { ...req, size: `${lotSize}` };
    });

    if (rest) payloads.push({ ...req, size: `${rest}` });

    return payloads;
  };

  private formatAlgoOrder = (opts: PlaceOrderOpts) => {
    const market = this.store.markets.find((m) => m.symbol === opts.symbol);
    if (!market) throw new Error(`Market ${opts.symbol} not found on Blofin`);

    const openPosition = this.store.positions.find(
      (p) =>
        p.contracts > 0 &&
        p.symbol === opts.symbol &&
        p.side ===
          (opts.side === OrderSide.Buy ? PositionSide.Short : PositionSide.Long)
    );

    if (!openPosition) {
      throw new Error(`No open position found for ${opts.symbol} on Blofin`);
    }

    const pPrice = market.precision.price;
    const price = opts.price ? adjust(opts.price, pPrice) : null;

    const pFactor = market.precision.amount;
    const pAmount = divide(pFactor, pFactor);

    const amount = adjust(divide(openPosition.contracts, pFactor), pAmount);

    const req: Record<string, any> = omitUndefined({
      instId: market.id,
      marginMode: 'cross',
      side: inverseObj(ORDER_SIDE)[opts.side],
      size: `${amount}`,
    });

    if (opts.type === OrderType.StopLoss) {
      req.slTriggerPrice = `${price}`;
      req.slOrderPrice = `-1`;
    }

    if (opts.type === OrderType.TakeProfit) {
      req.tpTriggerPrice = `${price}`;
      req.tpOrderPrice = `-1`;
    }

    return req;
  };

  private isAlgoOrder = (orderType: OrderType) => {
    return (
      orderType === OrderType.StopLoss ||
      orderType === OrderType.TakeProfit ||
      orderType === OrderType.TrailingStopLoss
    );
  };
}
