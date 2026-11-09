import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './tools';

// Stdout carries the protocol, so a stray log from any library would break the connection.
console.log = console.error;
console.info = console.error;
console.debug = console.error;

process.on('unhandledRejection', (error) => console.error('kitbasher-mcp:', error));

const { server, live } = createServer();

// The live view's sockets would otherwise keep this process alive after its client has gone.
const stop = () => {
  live.stop();
  process.exit(0);
};
process.stdin.once('end', stop);
process.stdin.once('close', stop);
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

await server.connect(new StdioServerTransport());
console.error('kitbasher-mcp ready');
