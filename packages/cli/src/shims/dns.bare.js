import dns from 'bare-dns'

export const lookup = dns.lookup.bind(dns)
