import type {OrderBook, Ticker, Writable} from '../../types';
import {BaseWebSocket} from '../base.ws';
import {calcOrderBookTotal, sortOrderBook} from '../../utils/orderbook';
import {KrakenExchange} from './kraken.exchange';
import {jsonParse} from '../../utils/json-parse';
import {BASE_WS_URL} from './kraken.types';
import flatten from 'lodash/flatten';

type Data = Record<string, any>;
type MessageHandlers = {
    [feed: string]: (json: Data) => void;
};

export class KrakenPublicWebsocket extends BaseWebSocket<KrakenExchange> {
    topics: { [feed: string]: Array<{ feed: string; product_id: string }> } = {};
    messageHandlers: MessageHandlers = {
        ticker: (data: Data) => this.handleTickersEvent(data),
        book_snapshot: (data: Data) => this.handleOrderBookEvent(data),
        book: (data: Data) => this.handleOrderBookEvent(data),
    };
    orderBookCallbacks: { [productId: string]: (orderBook: OrderBook) => void } = {};
    orderBooks: { [productId: string]: OrderBook } = {};

    connectAndSubscribe = () => {
        if (!this.isDisposed) {
            const baseURL =
                BASE_WS_URL.public[this.parent.options.testnet ? 'testnet' : 'livenet'];

            this.ws = new WebSocket(baseURL);

            this.topics = {
                ticker: this.parent.store.markets.map((m) => ({
                    feed: 'ticker',
                    product_id: m.id,
                })),
                book: [],
            };

            this.ws.addEventListener('open', this.onOpen);
            this.ws.addEventListener('message', this.onMessage);
            this.ws.addEventListener('close', this.onClose);
        }
    };

    onOpen = () => {
        if (!this.isDisposed) {
            this.subscribe();
        }
    };

    subscribe = () => {
        const topics = flatten(Object.values(this.topics));
        const feeds = [...new Set(topics.map((t) => t.feed))];

        feeds.forEach((feed) => {
            const product_ids = topics
                .filter((t) => t.feed === feed)
                .map((t) => t.product_id);

            if (product_ids.length > 0) {
                const payload = {
                    event: 'subscribe',
                    feed,
                    product_ids,
                };
                this.ws?.send?.(JSON.stringify(payload));
            }
        });
    };

    onMessage = ({data}: MessageEvent) => {
        if (this.isDisposed) return;

        const json = jsonParse(data);
        if (!json) return;

        const feed = json.feed;
        if (feed && this.messageHandlers[feed]) {
            this.messageHandlers[feed](json);
        }
    };

    handleTickersEvent = (data: Record<string, any>) => {
        const market = this.parent.store.markets.find((m) => m.id === data.product_id);
        const symbol = market ? market.symbol : null;

        if (symbol) {
            const ticker = this.parent.store.tickers.find((t) => t.symbol === symbol);

            if (ticker) {
                const update: Partial<Writable<Ticker>> = {};

                if (data.bid !== undefined) update.bid = data.bid;
                if (data.ask !== undefined) update.ask = data.ask;
                if (data.last !== undefined) update.last = data.last;
                if (data.markPrice !== undefined) update.mark = data.markPrice;
                if (data.index !== undefined) update.index = data.index;
                if (data.change !== undefined) update.percentage = data.change;
                if (data.openInterest !== undefined) update.openInterest = data.openInterest;
                if (data.funding_rate !== undefined) update.fundingRate = data.funding_rate;
                if (data.volume !== undefined) update.volume = data.volume;
                if (data.volumeQuote !== undefined) update.quoteVolume = data.volumeQuote;

                this.parent.store.updateTicker(ticker, update);
            }
        }
    };

    handleOrderBookEvent = (data: Record<string, any>) => {
        const productId = data.product_id;
        const callback = this.orderBookCallbacks[productId];
        if (!callback) return;

        let orderBook = this.orderBooks[productId];
        if (!orderBook) {
            orderBook = {bids: [], asks: []};
            this.orderBooks[productId] = orderBook;
        }

        if (data.feed === 'book_snapshot') {
            const {bids, asks} = data;

            orderBook.bids = bids.map(
                ({price, qty}: { price: number; qty: number }) => ({
                    price,
                    amount: qty,
                    total: 0,
                })
            );

            orderBook.asks = asks.map(
                ({price, qty}: { price: number; qty: number }) => ({
                    price,
                    amount: qty,
                    total: 0,
                })
            );
        } else if (data.feed === 'book') {
            const {price, qty, side} = data;
            const orderSide = side === 'buy' ? 'bids' : 'asks';

            const index = orderBook[orderSide].findIndex(
                (order) => order.price === price
            );

            if (qty === 0 && index !== -1) {
                orderBook[orderSide].splice(index, 1);
            } else if (index !== -1) {
                orderBook[orderSide][index].amount = qty;
            } else {
                orderBook[orderSide].push({
                    price: price,
                    amount: qty,
                    total: 0,
                });
            }
        }

        sortOrderBook(orderBook);
        calcOrderBookTotal(orderBook);
        callback(orderBook);
    };


    listenOrderBook = (
        symbol: string,
        callback: (orderBook: OrderBook) => void
    ) => {
        let timeoutId: NodeJS.Timeout | null = null;

        if (!this.store.loaded.markets) {
            timeoutId = setTimeout(() => this.listenOrderBook(symbol, callback), 100);
            return () => {
                if (timeoutId) {
                    clearTimeout(timeoutId);
                    timeoutId = null;
                }
            };
        }

        const market = this.store.markets.find((m) => m.symbol === symbol);
        if (!market) {
            return () => {
            };
        }

        const productId = market.id;

        const existingTopic = this.topics.book.find((t) => t.product_id === productId);
        if (!existingTopic) {
            this.topics.book.push({feed: 'book', product_id: productId});

            if (this.isConnected) {
                this.subscribe();
            }
        }

        this.orderBookCallbacks[productId] = callback;

        return () => {
            this.topics.book = this.topics.book.filter((t) => t.product_id !== productId);

            delete this.orderBookCallbacks[productId];
            delete this.orderBooks[productId];

            if (this.isConnected) {
                const payload = {
                    event: 'unsubscribe',
                    feed: 'book',
                    product_ids: [productId],
                };
                this.ws?.send?.(JSON.stringify(payload));
            }
        };
    };
}
