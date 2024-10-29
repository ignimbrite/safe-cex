import {BaseExchange} from '../base';
import {Axios} from 'axios';
import rateLimit from 'axios-rate-limit';
import {ENDPOINTS, ORDER_SIDE, ORDER_STATUS, ORDER_TYPE, POSITION_SIDE} from './kraken.types';
import type {Store} from '../../store/store.interface';
import {
    type Candle,
    ExchangeOptions,
    Market,
    type OHLCVOptions,
    Order,
    type OrderBook,
    OrderStatus,
    PlaceOrderOpts,
    Position,
    PositionSide,
    Ticker
} from '../../types';
import {createAPI} from "./kraken.api";
import {normalizeSymbol, reverseSymbol} from "./kraken.utils";
import {adjust} from "../../utils/safe-math";
import {omitUndefined} from "../../utils/omit-undefined";
import {inverseObj} from "../../utils/inverse-obj";
import {KrakenPublicWebsocket} from "./kraken.ws-public";
import {KrakenPrivateWebSocket} from "./kraken.ws-private";
import {roundUSD} from "../../utils/round-usd";

export class KrakenExchange extends BaseExchange {
    xhr: Axios;
    name = 'KRAKEN';

    publicWebsocket: KrakenPublicWebsocket;
    privateWebsocket: KrakenPrivateWebSocket

    // This model supports Multi-collateral, Linear Perpetuals with Cross Leverage
    constructor(opts: ExchangeOptions, store: Store) {
        super(opts, store);

        this.xhr = rateLimit(createAPI(opts), {maxRPS: 3});
        this.publicWebsocket = new KrakenPublicWebsocket(this);
        this.privateWebsocket = new KrakenPrivateWebSocket(this);
    }

    getAccount = async () => {
        const {data} = await this.xhr.get<Record<string, any>>(ENDPOINTS.ACCOUNT);

        if (data?.result !== 'success') {
            this.emitter.emit('error', data?.error);
            return {userId: '', affiliateId: ''};
        }

        return {
            userId: data?.masterAccountUid,
            affiliateId: '',
        };
    };

    validateAccount = async () => {
        try {
            const {data} = await this.xhr.get(ENDPOINTS.ACCOUNT);

            if (data?.result !== 'success') return data?.error;

            return 'Invalid API key, secret or passphrase';
        } catch (err) {
            return 'Invalid API key, secret or passphrase';
        }
    };

    dispose = () => {
        super.dispose();
        this.publicWebsocket.dispose();
        this.privateWebsocket.dispose();
    };

    start = async () => {
        const markets = await this.fetchMarkets();
        if (this.isDisposed) return;

        this.store.update({
            markets,
            loaded: {...this.store.loaded, markets: true},
        });

        const tickers = await this.fetchTickers();
        if (this.isDisposed) return;

        this.log(
            `Loaded ${Math.min(tickers.length, markets.length)} Kraken markets`
        );

        this.store.update({
            tickers,
            loaded: {...this.store.loaded, tickers: true},
        });

        const [balance, positions] = await Promise.all([
            this.fetchBalance(),
            this.fetchPositions(),
        ]);

        this.store.update({
            positions,
            balance: {
                ...balance,
            },
            loaded: {
                ...this.store.loaded,
                balance: true,
                positions: true,
            },
        });
        this.publicWebsocket.connectAndSubscribe();
        this.privateWebsocket.connectAndSubscribe();

        this.log(`Ready to trade on Kraken`);

        const orders = await this.fetchOrders();
        if (this.isDisposed) return;

        this.log(`Loaded ${orders.length} open orders`);

        this.store.update({
            orders,
            loaded: {...this.store.loaded, orders: true},
        });
    };

    listenOrderBook = (
        symbol: string,
        callback: (orderBook: OrderBook) => void
    ) => {
        return this.publicWebsocket.listenOrderBook(symbol, callback);
    };

    fetchMarkets = async () => {
        try {
            const {data} = await this.xhr.get<{ instruments: Array<Record<string, any>> }>(ENDPOINTS.MARKETS);

            const markets: Market[] = data.instruments
                .filter((m: any) => m.type === 'flexible_futures')
                .map((m: any) => {
                    const cleanSymbol = m.symbol.replace('PF_', '');
                    const [baseAsset] = cleanSymbol.split('USD');

                    const minSize = Math.pow(10, -m.contractValueTradePrecision) * m.contractSize

                    return {
                        id: m.symbol,
                        symbol: cleanSymbol,
                        base: baseAsset,
                        quote: 'USD',
                        active: m.tradeable,
                        precision: {
                            amount: minSize,
                            price: m.tickSize,
                        },
                        limits: {
                            amount: {
                                min: minSize,
                                max: m.maxPositionSize,
                            },
                            leverage: {
                                min: 1,
                                max: 50,
                            },
                        },
                    };
                });

            return markets;
        } catch (err: any) {
            this.emitter.emit('error', err?.error);
            return this.store.markets;
        }
    };

    fetchTickers = async () => {
        try {
            const {
                data: {tickers},
            } = await this.xhr.get<{ tickers: Array<Record<string, any>> }>(ENDPOINTS.TICKERS);

            const tickersList: Ticker[] = tickers
                .reduce((acc: Ticker[], t: Record<string, any>) => {
                        const symbol = normalizeSymbol(t.symbol);
                        const market = this.store.markets.find((m) => m.symbol === symbol);

                        if (!market) return acc;

                        const ticker: Ticker = {
                            id: market.id,
                            symbol: market.symbol,
                            bid: t.bid,
                            ask: t.ask,
                            last: t.last,
                            mark: t.markPrice,
                            index: t.indexPrice,
                            percentage: t.change24h,
                            fundingRate: t.fundingRate,
                            volume: t.volumeQuote * t.last,
                            quoteVolume: t.volumeQuote,
                            openInterest: t.openInterest,
                        };

                        return [...acc, ticker];
                    },
                    []
                );

            return tickersList;
        } catch (err: any) {
            this.emitter.emit('error', err?.error);
            return this.store.tickers;
        }
    };

    fetchBalance = async () => {
        try {
            const {data} = await this.xhr.get<Record<string, any>>(ENDPOINTS.BALANCE);

            if (data?.result !== 'success') {
                this.emitter.emit('error', data?.error);
                return this.store.balance;
            }

            const flexAccount = data?.accounts?.flex
            const balance = {
                total: roundUSD(flexAccount?.balanceValue),
                free: roundUSD(flexAccount?.availableMargin),
                used: roundUSD(flexAccount?.initialMargin),
                upnl: roundUSD(flexAccount?.totalUnrealized),
            };

            return balance;
        } catch (err: any) {
            this.emitter.emit('error', err?.error);
            return this.store.balance;
        }
    };

    fetchPositions = async () => {
        try {
            const {data: {openPositions}} = await this.xhr.get<{
                openPositions: Array<Record<string, any>>;
                result: string;
            }>(ENDPOINTS.POSITIONS);

            const formattedPositions = openPositions.reduce<Position[]>((acc, p) => {
                const symbol = normalizeSymbol(p.symbol);
                const ticker = this.store.tickers.find(t => t.symbol === symbol);
                if (!ticker) return acc;

                const market = this.store.markets.find((m) => m.symbol === symbol);
                if (!market) return acc;

                const pPrice = market.precision.price;

                const entryPrice = adjust(p.price, pPrice);

                const size = p.size;
                const side = POSITION_SIDE[p.side];
                const markPrice = ticker.mark;

                const pnl = side === PositionSide.Long
                    ? (markPrice - entryPrice) * size
                    : (entryPrice - markPrice) * size;

                const notional = roundUSD(size * markPrice);

                const position = {
                    symbol,
                    side,
                    entryPrice,
                    notional,
                    unrealizedPnl: roundUSD(pnl),
                    contracts: size,
                    leverage: 0,
                    liquidationPrice: 0,
                };

                return [...acc, position];
            }, []);

            return formattedPositions;
        } catch (err: any) {
            this.emitter.emit('error', err?.error);
            return this.store.positions;
        }
    };

    fetchOrders = async () => {
        try {
            const {data} = await this.xhr.get<{ openOrders: Array<Record<string, any>> }>(
                ENDPOINTS.ORDERS
            );

            const orders: Order[] = data.openOrders.reduce<Order[]>((acc, o) => {
                const order = this.mapOrders(o);
                return order !== null ? [...acc, order] : acc;
            }, []);


            return orders;
        } catch (err: any) {
            this.emitter.emit('error', err?.error);
            return [];
        }
    };

    mapOrders = (o: Record<string, any>) => {
        const symbol = normalizeSymbol(o.symbol || o.instrument);
        const market = this.store.markets.find((m) => m.symbol === symbol);

        if (!market) return null;

        const sideValue = o.side || (o.direction === 0 ? 'buy' : 'sell');
        const side = ORDER_SIDE[sideValue];

        const typeValue = o.orderType || o.type;
        const orderType = ORDER_TYPE[typeValue] || typeValue;

        const price = (orderType === 'stop_market' || orderType === 'take_profit_market')
            ? (o.stopPrice || o.stop_price || '0')
            : (o.limitPrice || o.limit_price || '0');

        const status = ORDER_STATUS[o.status] || this.getOrderStatus(o);

        const amount = (o.qty || o.unfilledSize || '0');
        const filled = (o.filled || o.filledSize || '0');
        const remaining = amount - filled;

        const order: Order = {
            id: o.order_id,
            symbol,
            type: orderType,
            side,
            price,
            status,
            amount,
            reduceOnly: o.reduceOnly || o.reduce_only || false,
            filled,
            remaining,
        };

        return order;
    };

    private getOrderStatus = (data: any): OrderStatus => {
        if (data.is_cancel) {
            return OrderStatus.Canceled;
        } else if (data.filled === data.qty && data.qty > 0) {
            return OrderStatus.Closed;
        } else if (data.filled > 0) {
            return OrderStatus.Open;
        } else {
            return OrderStatus.Open;
        }
    };

    cancelAllOrders = async () => {
        try {
            await this.xhr.post(ENDPOINTS.CANCEL_ALL_ORDERS);
        } catch (err: any) {
            this.emitter.emit('error', err?.error);
        }
    }

    cancelSymbolOrders = async (symbol: string) => {
        try {
            const krakenSymbol = reverseSymbol(symbol);
            await this.xhr.post(ENDPOINTS.CANCEL_ORDERS, null, {
                params: {symbol: krakenSymbol},
            });
        } catch (err: any) {
            this.emitter.emit('error', err?.error)
        }
    };

    cancelOrders = async (orders: Order[]) => {
        const batchOrder = orders.map((order) => ({
            order: 'cancel',
            order_id: order.id,
        }));

        const batchOrderPayload = {
            batchOrder: batchOrder,
        };

        const postData = `json=${encodeURIComponent(JSON.stringify(batchOrderPayload))}`;

        try {
            const {data} = await this.xhr.post(ENDPOINTS.CANCEL_ORDERS, postData);

            if (data.result !== 'success') {
                this.emitter.emit('error', data.error);
            }

        } catch (err: any) {
            const errMsg = err?.error;
            this.emitter.emit('error', errMsg);
        }
    };

    fetchOHLCV = async (opts: OHLCVOptions) => {
        const market = this.store.markets.find((m) => m.symbol === opts.symbol);

        if (!market) {
            this.emitter.emit('error', `Market ${opts.symbol} not found`);
            return [];
        }

        const symbol = reverseSymbol(opts.symbol);
        const resolution = opts.interval;
        const tickType = 'trade';

        const url = `${ENDPOINTS.KLINE}/${tickType}/${symbol}/${resolution}`;

        try {
            const {data} = await this.xhr.get(url);

            const candles: Candle[] = data.candles.map((c: Record<string, any>) => {
                return {
                    timestamp: c.time / 1e3,
                    open: parseFloat(c.open),
                    high: parseFloat(c.high),
                    low: parseFloat(c.low),
                    close: parseFloat(c.close),
                    volume: parseFloat(c.volume),
                };
            });

            candles.sort((a, b) => a.timestamp - b.timestamp);


            return candles;
        } catch (err: any) {
            this.emitter.emit('error', err?.error);
            return [];
        }
    };

    placeOrder = async (opts: PlaceOrderOpts) => {
        if (opts.type === 'market') {
            return await this.placeSimpleOrder(opts);
        } else {
            const hasAttachedOrders = opts.stopLoss || opts.takeProfit;
            if (hasAttachedOrders) {
                return await this.placeOrders([opts]);
            } else {
                return await this.placeSimpleOrder(opts);
            }
        }
    };

    private placeSimpleOrder = async (opts: PlaceOrderOpts) => {
        const market = this.store.markets.find((m) => m.symbol === opts.symbol);
        if (!market) {
            throw new Error(`Market not found: ${opts.symbol}`);
        }

        const pPrice = market.precision.price;
        const pSize = market.precision.amount;

        const size = adjust(opts.amount, pSize);
        const price = opts.price ? adjust(opts.price, pPrice) : undefined;

        const orderType = inverseObj(ORDER_TYPE)[opts.type];
        const side = inverseObj(ORDER_SIDE)[opts.side];
        const symbol = reverseSymbol(opts.symbol);

        const orderReq = omitUndefined({
            orderType: orderType,
            symbol: symbol,
            side: side,
            size: size,
            limitPrice: price ? price : undefined,
            reduceOnly: opts.reduceOnly,
        });

        const orderIds: string[] = [];

        try {
            const { data } = await this.xhr.post(ENDPOINTS.PLACE_ORDER, null, { params: orderReq });

            if (data.sendStatus.status !== 'placed') {
                const errStatus = data.sendStatus.status;
                this.emitter.emit('error', errStatus);
            } else {
                const orderId = data.sendStatus.order_id as string;
                orderIds.push(orderId);
            }

            const orderId = data.sendStatus.order_id as string;
            orderIds.push(orderId);

            const attachedOrderPromises = [];

            const oppositeSide = side === 'buy' ? 'sell' : 'buy';

            if (opts.stopLoss) {
                const stopLossPrice = adjust(opts.stopLoss, pPrice);
                const slOrderReq = omitUndefined({
                    orderType: 'stp',
                    symbol: symbol,
                    side: oppositeSide,
                    size: size,
                    stopPrice: stopLossPrice,
                    reduceOnly: true,
                });

                attachedOrderPromises.push(
                    this.xhr
                        .post(ENDPOINTS.PLACE_ORDER, null, { params: slOrderReq })
                        .then((slData) => {
                            if (slData.data.result !== 'success') {
                                throw new Error(slData.data?.error);
                            }
                            const slOrderId = slData.data.sendStatus.order_id as string;
                            orderIds.push(slOrderId);
                        })
                        .catch((err) => {
                            const errMsg = err?.error || err.message;
                            this.emitter.emit('error', `Stop Loss Error: ${errMsg}`);
                        })
                );
            }

            if (opts.takeProfit) {
                const takeProfitPrice = adjust(opts.takeProfit, pPrice);
                const tpOrderReq = omitUndefined({
                    orderType: 'take_profit',
                    symbol: symbol,
                    side: oppositeSide,
                    size: size,
                    stopPrice: takeProfitPrice,
                    reduceOnly: true,
                });

                attachedOrderPromises.push(
                    this.xhr
                        .post(ENDPOINTS.PLACE_ORDER, null, { params: tpOrderReq })
                        .then((tpData) => {
                            if (tpData.data.result !== 'success') {
                                throw new Error(tpData.data?.error);
                            }
                            const tpOrderId = tpData.data.sendStatus.order_id as string;
                            orderIds.push(tpOrderId);
                        })
                        .catch((err) => {
                            const errMsg = err?.error || err.message;
                            this.emitter.emit('error', `Take Profit Error: ${errMsg}`);
                        })
                );
            }

            await Promise.all(attachedOrderPromises);

            return orderIds;
        } catch (err: any) {
            const errMsg = err?.error || err.message;
            this.emitter.emit('error', errMsg);
            return orderIds;
        }
    };

    placeOrders = async (ordersOpts: PlaceOrderOpts[]) => {
        const batchOrder = [];

        for (const opts of ordersOpts) {
            const market = this.store.markets.find((m) => m.symbol === opts.symbol);
            if (!market) {
                throw new Error(`Market not found: ${opts.symbol}`);
            }

            const pPrice = market.precision.price;
            const pSize = market.precision.amount;

            const size = adjust(opts.amount, pSize);
            const price = opts.price ? adjust(opts.price, pPrice) : undefined;

            const orderType = inverseObj(ORDER_TYPE)[opts.type];
            const side = inverseObj(ORDER_SIDE)[opts.side];
            const oppositeSide = side === 'buy' ? 'sell' : 'buy';
            const symbol = reverseSymbol(opts.symbol);

            const baseOrderReq = omitUndefined({
                order: 'send',
                symbol: symbol,
                orderType: orderType,
                limitPrice: price,
                side: side,
                size: size,
                order_tag: 'baseOrder',
            });
            batchOrder.push(baseOrderReq);

            if (opts.stopLoss) {
                const stopLossPrice = adjust(opts.stopLoss, pPrice);

                const stopLossReq = omitUndefined({
                    order: 'send',
                    symbol: symbol,
                    orderType: 'stp',
                    stopPrice: stopLossPrice,
                    side: oppositeSide,
                    size: size,
                    reduceOnly: true,
                    order_tag: 'stopLossOrder',
                });
                batchOrder.push(stopLossReq);
            }

            if (opts.takeProfit) {
                const takeProfitPrice = adjust(opts.takeProfit, pPrice);

                const takeProfitReq = omitUndefined({
                    order: 'send',
                    symbol: symbol,
                    orderType: 'take_profit',
                    stopPrice: takeProfitPrice,
                    side: oppositeSide,
                    size: size,
                    reduceOnly: true,
                    order_tag: 'takeProfitOrder',
                });
                batchOrder.push(takeProfitReq);
            }
        }

        try {
            const batchOrderPayload = {
                batchOrder: batchOrder,
            };

            const postData = `json=${encodeURIComponent(JSON.stringify(batchOrderPayload))}`;

            const { data } = await this.xhr.post(ENDPOINTS.PLACE_ORDERS, postData);

            if (data.result !== 'success') {
                throw new Error(data?.error);
            }

            const orderIds: string[] = [];

            for (const orderStatus of data.batchStatus) {
                if (orderStatus.status !== 'placed') {
                    const errStatus = orderStatus.status;
                    this.emitter.emit('error', errStatus);
                } else {
                    const orderId = orderStatus.order_id as string;
                    orderIds.push(orderId);
                }
            }

            return orderIds;
        } catch (err: any) {
            const errMsg = err?.error || err.message;
            this.emitter.emit('error', errMsg);
            return [];
        }
    };

    mapPosition = (p: Record<string, any>) => {
        const symbol = normalizeSymbol(p.instrument);

        const market = this.store.markets.find((m) => m.symbol === symbol);
        if (!market) throw new Error(`Market ${p.symbol} not found on Kraken`);

        const pPrice = market.precision.price;
        const entryPrice = adjust(p.entry_price, pPrice);
        const liquidationPrice = adjust(p.liquidation_threshold, pPrice);

        const balance = (p.balance);
        const side = balance >= 0 ? PositionSide.Long : PositionSide.Short;
        const size = Math.abs(balance);
        const markPrice = (p.mark_price);
        const pnl = roundUSD(p.pnl);
        const leverage = roundUSD(p.effective_leverage);

        const notional = roundUSD(size * markPrice);

        const position: Position = {
            symbol,
            side,
            entryPrice,
            notional,
            unrealizedPnl: pnl,
            contracts: size,
            leverage,
            liquidationPrice,
        };

        return position;
    };
}
