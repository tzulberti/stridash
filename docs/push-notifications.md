# Push notifications

Stridash sends a best-effort Expo push notification after a sync that **created**
at least one activity: `N new activities synced`.

## Server

- Tokens are registered at `POST /api/push-tokens`
  `{ "token": "ExponentPushToken[…]","platform":"ios|android|web" }`.
- A device token is unique and re-registering it refreshes `lastSeenAt` and
  moves it to the latest user on that device.
- `DELETE /api/push-tokens` with `{ "token": "…" }` removes it.
- The sync worker calls Expo's push endpoint fire-and-forget after the
  activity sync; it never holds the connection lock while Expo is slow.
- Tokens Expo reports as `DeviceNotRegistered` are pruned automatically.

No extra server env is needed. The server only talks to
`https://exp.host/--/api/v2/push/send`.

## Mobile

The mobile app requests notification permission and registers its Expo push
token when a dashboard token is present. It needs an EAS project id:

```dotenv
EXPO_PUBLIC_EAS_PROJECT_ID=00000000-0000-0000-0000-000000000000
```

Without it, registration is skipped (the app still works). On web the feature
is skipped.

## Limits

- Notifications are best-effort; there is no retry/backoff queue for Expo yet.
- Only activity creation is notified. Sleep/weight/BP ingest and sync failures
  do not send pushes.
- Users can revoke a device by signing out/removing the token (the server API
  is available if the client needs explicit unregistration).
