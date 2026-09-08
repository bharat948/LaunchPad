import dotenv from 'dotenv';
import { createApp } from './createApp.js';

dotenv.config();

const INSTANCE_ID = process.env.INSTANCE_ID || 'primary';
export const app = createApp({ instanceId: INSTANCE_ID });

const PORT = process.env.PORT || 3000;

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`[Launchpad Instance: ${INSTANCE_ID}] Server listening on http://localhost:${PORT}`);
  });
}
