import memoize from 'lodash/memoize';

export const normalizeSymbol = memoize((str: string | undefined) => {
    if (!str) {
        return '';
    }
    return str.replace('PF_', '');
});


export const reverseSymbol = memoize((str: string) => {
    return `PF_${str}`;
});
