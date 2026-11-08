/** Browsers have no domainToUnicode. xn-- hosts are left encoded, so homograph hosts are reported by the rule that follows. */
export const domainToUnicode = (host: string) => host;
