import dns from 'dns';
import net from 'net';

// Connect over IPv4, one address at a time, with the OS connect timeout.
//
// Node 20 otherwise tries IPv6 and IPv4 addresses in turn and gives each only
// 250 ms. Where IPv6 doesn't route and the database is far away (Neon in
// us-east-1 takes ~0.3 s to connect from Pakistan), every attempt is cut off
// and most new database connections fail with "AggregateError ETIMEDOUT".
// That shows up as GraphQL "Unauthorized", login 500s and failed chat answers.
//
// Imported first by server.ts and config/database.ts, so it is set before any
// connection is opened (scripts that use the database get it too).
dns.setDefaultResultOrder('ipv4first');
net.setDefaultAutoSelectFamily(false);
