import axios, { AxiosHeaders } from 'axios';
import { createHmac, createHash } from 'crypto';
import qs from 'qs';
import type { ExchangeOptions } from '../../types';
import { BASE_URL, PUBLIC_ENDPOINTS, RECV_WINDOW } from './kraken.types';

const getBaseURL = (options: ExchangeOptions) => {
    const baseURL = options.testnet ? BASE_URL.testnet : BASE_URL.livenet;
    return options.corsAnywhere ? `${options.corsAnywhere}/${baseURL}` : baseURL;
};

export const createAPI = (options: ExchangeOptions) => {
    const baseURL = getBaseURL(options);

    const xhr = axios.create({
        baseURL: baseURL,
    });

    xhr.interceptors.request.use((config) => {
        if (PUBLIC_ENDPOINTS.some((str) => config.url?.startsWith(str))) {
            return config;
        }

        const nonce = (Date.now() * 1000).toString();

        const fullURL = new URL(config.url || '', baseURL);
        let endpointPath = fullURL.pathname;

        if (endpointPath.startsWith('/derivatives')) {
            endpointPath = endpointPath.replace('/derivatives', '');
        }

        let message = '';
        let contentType = '';

        if (config.data) {
            if (typeof config.data === 'string') {
                message = config.data + nonce + endpointPath;
                contentType = 'application/x-www-form-urlencoded';
            } else {
                const dataString = JSON.stringify(config.data);
                message = dataString + nonce + endpointPath;
                config.data = dataString;
                contentType = 'application/json';
            }
        } else if (config.params) {
            const paramsString = qs.stringify(config.params);
            message = paramsString + nonce + endpointPath;
            contentType = 'application/x-www-form-urlencoded';

            if (config.method?.toUpperCase() === 'POST') {
                config.data = paramsString;
                config.params = {};
            }
        } else {
            message = nonce + endpointPath;
            contentType = 'application/json';
        }

        const sha256Hash = createHash('sha256').update(message).digest();
        const apiSecret = Buffer.from(options.secret, 'base64');

        const signature = createHmac('sha512', apiSecret)
            .update(sha256Hash)
            .digest('base64');

        if (!(config.headers instanceof AxiosHeaders)) {
            config.headers = new AxiosHeaders(config.headers);
        }

        config.headers.set('APIKey', options.key);
        config.headers.set('Nonce', nonce);
        config.headers.set('Authent', signature);

        if (contentType) {
            config.headers.set('Content-Type', contentType);
        }

        return {
            ...config,
            timeout: options?.extra?.recvWindow ?? RECV_WINDOW,
        };
    });

    return xhr;
};
