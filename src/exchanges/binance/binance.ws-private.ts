import { OrderStatus } from '../../types';

import type { Binance } from './binance.exchange';
import {
  BASE_WS_URL,
  ENDPOINTS,
  ORDER_SIDE,
  ORDER_TYPE,
  POSITION_SIDE,
} from './binance.types';

export class BinancePrivateWebsocket {
  ws?: WebSocket;
  parent: Binance;

  constructor(parent: Binance) {
    this.parent = parent;
    this.connectAndSubscribe();
  }

  connectAndSubscribe = async () => {
    const listenKey = await this.fetchListenKey();

    const key = this.parent.options.testnet ? 'testnet' : 'livenet';
    const base = BASE_WS_URL.private[key];

    const url = this.parent.options.testnet
      ? `${base}/${listenKey}`
      : `${base}/${listenKey}?listenKey=${listenKey}`;

    this.ws = new WebSocket(url);
    this.ws.addEventListener('message', this.onMessage);
    this.ws.addEventListener('close', this.onClose);
  };

  onMessage = ({ data }: MessageEvent) => {
    if (!this.parent.isDisposed) {
      const json = JSON.parse(data);
      const events = Array.isArray(json) ? json : [json];

      const orderEvents = events.filter((e) => e.e === 'ORDER_TRADE_UPDATE');
      this.handleOrderEvents(orderEvents);

      const accountEvents = events.filter((e) => e.e === 'ACCOUNT_UPDATE');
      this.handleAccountEvents(accountEvents);
    }
  };

  onClose = () => {
    this.ws?.removeEventListener?.('message', this.onMessage);
    this.ws?.removeEventListener?.('close', this.onClose);
    this.ws = undefined;

    if (!this.parent.isDisposed) {
      this.connectAndSubscribe();
    }
  };

  handleOrderEvents = (events: Array<Record<string, any>>) => {
    events.forEach(({ o: data }) => {
      if (data.X === 'PARTIALLY_FILLED' || data.X === 'FILLED') {
        this.parent.emitter.emit('fill', {
          side: ORDER_SIDE[data.S],
          symbol: data.s,
          price: parseFloat(data.ap),
          amount: parseFloat(data.l),
        });
      }

      if (data.X === 'NEW') {
        this.parent.addOrReplaceOrderFromStore({
          id: data.c,
          status: OrderStatus.Open,
          symbol: data.s,
          type: ORDER_TYPE[data.ot],
          side: ORDER_SIDE[data.S],
          price: parseFloat(data.p) || parseFloat(data.sp),
          amount: parseFloat(data.q),
          filled: parseFloat(data.z),
          remaining: parseFloat(data.q) - parseFloat(data.z),
          reduceOnly: data.R || false,
        });
      }

      if (data.X === 'CANCELED' || data.X === 'FILLED') {
        this.parent.removeOrderFromStore(data.c);
      }
    });
  };

  handleAccountEvents = (events: Array<Record<string, any>>) => {
    events.forEach((event) =>
      event.a.B.forEach((p: Record<string, any>) => {
        const symbol = p.s;
        const side = POSITION_SIDE[p.ps];

        const position = this.parent.store.positions.find(
          (p2) => p2.symbol === symbol && p2.side === side
        );

        if (position) {
          const entryPrice = parseFloat(p.ep);
          const contracts = parseFloat(p.pa);
          const upnl = parseFloat(p.up);

          position.entryPrice = entryPrice;
          position.contracts = contracts;
          position.notional = contracts * entryPrice + upnl;
          position.unrealizedPnl = upnl;
        }
      })
    );
  };

  dispose = () => {
    this.ws?.close?.();
  };

  private fetchListenKey = async () => {
    const { data } = await this.parent.xhr.post(ENDPOINTS.LISTEN_KEY);
    setTimeout(() => this.updateListenKey(), 30 * 60 * 1000);
    return data.listenKey;
  };

  private updateListenKey = async () => {
    if (!this.parent.isDisposed) {
      await this.parent.xhr.put(ENDPOINTS.LISTEN_KEY);
      setTimeout(() => this.updateListenKey(), 30 * 60 * 1000);
    }
  };
}