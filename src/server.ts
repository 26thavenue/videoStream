import { Hono } from 'hono';
import { serve } from '@hono/node-server';

const app = new Hono();

serve({ fetch: app.fetch, port: 3000 });
console.log('server running on http://localhost:3000');
