import {OrderSide, OrderStatus, OrderType, PositionSide} from "../../types";

export const RECV_WINDOW = 5000;

export const BASE_URL = {
    livenet: 'https://futures.kraken.com',
    testnet: 'https://demo-futures.kraken.com',
};

export const BASE_WS_URL = {
    public: {
        livenet: 'wss://futures.kraken.com/ws/v1/',
        testnet: 'wss://demo-futures.kraken.com/ws/v1/',
    },
    private: {
        livenet: 'wss://futures.kraken.com/ws/v1/',
        testnet: 'wss://demo-futures.kraken.com/ws/v1/',
    },
};

export const ENDPOINTS = {
    MARKETS: '/derivatives/api/v3/instruments',
    ACCOUNT: '/derivatives/api/v3/subaccounts',
    TICKERS: '/derivatives/api/v3/tickers',
    BALANCE: '/derivatives/api/v3/accounts',
    POSITIONS: '/derivatives/api/v3/openpositions',
    ORDERS: '/derivatives/api/v3/openorders',
    CANCEL_ALL_ORDERS: '/derivatives/api/v3/cancelallorders',
    KLINE: '/api/charts/v1',
    PLACE_ORDER: '/derivatives/api/v3/sendorder',
    PLACE_ORDERS: '/derivatives/api/v3/batchorder',
    CANCEL_ORDERS: '/derivatives/api/v3/batchorder'
};

export const PUBLIC_ENDPOINTS = [
    ENDPOINTS.MARKETS,
    ENDPOINTS.TICKERS,
    ENDPOINTS.MARKETS,
    ENDPOINTS.KLINE
];

export const ORDER_STATUS: Record<string, OrderStatus> = {
    untouched: OrderStatus.Open,
    partiallyFilled: OrderStatus.Open,
    filled: OrderStatus.Closed,
    cancelled: OrderStatus.Canceled,
};

export const ORDER_TYPE: Record<string, OrderType> = {
    lmt: OrderType.Limit,
    mkt: OrderType.Market,
    stop: OrderType.StopLoss,
    take_profit: OrderType.TakeProfit,
};

export const ORDER_SIDE: Record<string, OrderSide> = {
    buy: OrderSide.Buy,
    sell: OrderSide.Sell,
};

export const POSITION_SIDE: Record<string, PositionSide> = {
    long: PositionSide.Long,
    short: PositionSide.Short,
};
