/** A resolver that answers every host with one public address, so no test needs real DNS. */
export const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];
