/**
 * Manage Strava push subscriptions:
 *   npm run strava:webhook -w @stridash/server -- list
 *   npm run strava:webhook -w @stridash/server -- create
 *   npm run strava:webhook -w @stridash/server -- delete <id>
 */
import { loadEnv } from '../env.js';
import {
  createStravaSubscription,
  deleteStravaSubscription,
  listStravaSubscriptions,
  stravaWebhookConfig,
} from '../services/strava-webhooks.js';

const [command = 'list', arg] = process.argv.slice(2);
const config = stravaWebhookConfig(loadEnv());

if (command === 'list') {
  console.log(JSON.stringify(await listStravaSubscriptions(config), null, 2));
} else if (command === 'create') {
  console.log(JSON.stringify(await createStravaSubscription(config), null, 2));
} else if (command === 'delete') {
  if (!arg) throw new Error('Usage: strava:webhook -- delete <subscription-id>');
  await deleteStravaSubscription(config, arg);
  console.log(`Deleted Strava push subscription ${arg}`);
} else {
  throw new Error(`Unknown command "${command}" — use list, create or delete <id>`);
}
