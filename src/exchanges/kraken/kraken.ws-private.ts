import createHmac from 'create-hmac';
import {createHash} from 'crypto';
import {BaseWebSocket} from '../base.ws';
import {jsonParse} from '../../utils/json-parse';
import {BASE_WS_URL} from './kraken.types';
import {KrakenExchange} from './kraken.exchange';
import {Order, OrderStatus, Position} from '../../types';
import {roundUSD} from "../../utils/round-usd";

export class KrakenPrivateWebSocket extends BaseWebSocket<KrakenExchange> {
    private challenge: string = '';
    private signedChallenge: string = '';
    subscriptions: Set<string> = new Set();

    constructor(parent: KrakenExchange) {
        super(parent);
    }

    connectAndSubscribe = () => {
        if (this.isDisposed) return;

        const baseURL =
            BASE_WS_URL.private[
                this.parent.options.testnet ? 'testnet' : 'livenet'
                ];

        this.ws = new WebSocket(baseURL);
        this.ws.addEventListener('open', this.onOpen);
        this.ws.addEventListener('message', this.onMessage);
        this.ws.addEventListener('close', this.onClose);
    };

    onOpen = () => {
        if (this.isDisposed) return;
        this.requestChallenge();
        this.ping();
    };

    ping = () => {
        if (!this.isDisposed) {
            this.pingAt = performance.now();
            this.ws?.send(JSON.stringify({"event": "ping"}));
        }
    };

    onMessage = ({data}: MessageEvent) => {

        const parsed = jsonParse(data);

        if (parsed?.event === 'alert' && parsed?.message === 'Bad websocket message') {
            this.handlePongEvent();
            return;
        }

        if (parsed?.event === 'challenge') {
            this.challenge = parsed.message;
            this.signedChallenge = this.signChallenge(this.challenge);
            this.sendSubscribeRequest();
            return;
        }

        if (parsed?.event === 'subscribed') {
            this.subscriptions.add(parsed.feed);
            return;
        }

        if (parsed?.feed === 'open_orders_snapshot') {
            this.handleOpenOrdersSnapshot(parsed);
            return;
        }

        if (parsed?.feed === 'open_orders') {
            this.handleOpenOrdersFeed(parsed);
            return;
        }

        if (parsed?.feed === 'open_positions') {
            this.handleOpenPositionsFeed(parsed);
            return;
        }

        if (parsed?.feed === 'balances' || parsed?.feed === 'balances_snapshot') {
            this.handleBalancesMessage(parsed);
            return;
        }

    };

    handlePongEvent = () => {
        const diff = performance.now() - (this.pingAt || 0);
        this.store.update({latency: Math.round(diff / 2)});

        if (this.pingTimeoutId) {
            clearTimeout(this.pingTimeoutId);
            this.pingTimeoutId = undefined;
        }

        this.pingTimeoutId = setTimeout(() => this.ping(), 10_000);
    };

    requestChallenge() {
        const payload = JSON.stringify({
            event: 'challenge',
            api_key: this.parent.options.key,
        });
        this.ws?.send(payload);
    }

    signChallenge(challenge: string): string {
        const sha256Hash = createHash('sha256').update(challenge).digest();
        const decodedSecret = Buffer.from(this.parent.options.secret, 'base64');
        const hmacSha512 = createHmac('sha512', decodedSecret)
            .update(sha256Hash)
            .digest();
        return hmacSha512.toString('base64');
    }

    sendSubscribeRequest() {
        if (this.challenge && this.signedChallenge) {
            const feeds = ['open_orders', 'open_positions', 'balances'];
            feeds.forEach((feed) => {
                const payload = JSON.stringify({
                    event: 'subscribe',
                    feed,
                    api_key: this.parent.options.key,
                    original_challenge: this.challenge,
                    signed_challenge: this.signedChallenge,
                });
                this.ws?.send(payload);
            });
        }
    }

    handleOpenOrdersSnapshot(data: any) {
        const ordersData = data.orders || [];
        const orders = ordersData
            .map((orderData: any) => this.parent.mapOrders(orderData))
            .filter((order: Order | null): order is Order => order !== null);
        this.store.update({orders});
    }

    handleOpenOrdersFeed = (data: any) => {
        if (data.order) {
            const orderData = data.order;
            const order = this.parent.mapOrders(orderData);
            if (!order) return;

            const status = order.status;

            if (status === OrderStatus.Canceled) {
                this.store.removeOrders([order]);
            } else if (status === OrderStatus.Closed) {
                this.store.removeOrders([order]);
                this.emitter.emit('fill', {
                    side: order.side,
                    symbol: order.symbol,
                    price: order.price,
                    amount: order.filled,
                });
            } else if (status === OrderStatus.Open) {
                this.store.addOrUpdateOrders([order]);
                this.emitter.emit('fill', {
                    side: order.side,
                    symbol: order.symbol,
                    price: order.price,
                    amount: order.filled,
                });
            } else {
                this.store.addOrUpdateOrders([order]);
            }
        } else if (data.order_id && data.is_cancel) {
            const orderId = data.order_id;
            const order = this.store.orders.find((o) => o.id === orderId);
            if (order) {
                this.store.removeOrders([order]);
            }
        }
    };

    handleOpenPositionsFeed(data: any) {
        const positionsData = data.positions || [];
        const positions = positionsData
            .map((positionData: any) => this.parent.mapPosition(positionData))
            .filter((position: Position | null): position is Position => position !== null);
        this.store.update({positions});
    }

    handleBalancesMessage(data: any) {
        const flexFutures = data?.flex_futures;
        if (!flexFutures) {
            return;
        }

        const balance = {
            total: roundUSD(flexFutures.balance_value),
            free: roundUSD(flexFutures.available_margin),
            used: roundUSD(flexFutures.initial_margin),
            upnl: roundUSD(flexFutures.total_unrealized),
        };

        this.store.update({balance});
    }
}
