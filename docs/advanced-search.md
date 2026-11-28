# Advanced activity search

The web app's `/search` page is a small query builder for the activity history.
Every condition is combined with **AND**; an empty condition is simply ignored.

## Filters

| Filter | UI | JSON body field |
|---|---|---|
| Date range | start date, end date (either side optional) | `from`, `to` (ISO datetimes) |
| Activity types | multi-select chips (RUN, RIDE, VIRTUAL_RIDE, WALK, HIKE, SWIM, WORKOUT, OTHER) | `types: ["RUN", "RIDE"]` |
| Gear | one gear item, or any gear | `gearId: "<uuid>"` |
| Distance | minimum / maximum in the active unit (km or mi) | `distanceMinM`, `distanceMaxM` (meters) |

The result table is paginated 100 rows at a time; **Load more** passes the
previous `nextCursor` back to the same query.

## Query-builder behaviour

- The four filters are shown by default. Each row can be removed and added back
  from the **Add filter** picker; removing a row clears its value.
- **Search** applies the current form. **Clear filters** resets all values and
  runs an unfiltered search.
- The distance range is validated client-side (minimum cannot exceed maximum)
  and again server-side.
- The current form is written to the URL as `from`, `to`, `types`, `gearId`,
  `dminM`, `dmaxM`, plus `show` when some filter rows are hidden. Search links
  are therefore shareable and survive a reload.
- Distance values are stored in meters in the URL/API; the inputs display the
  user's selected unit.

## API

The web page uses HTTP `QUERY` (RFC 10008) so filters can grow into nested or
large structures without URL-length limits:

```http
QUERY /api/activities/query
Authorization: Bearer <token>
Content-Type: application/json

{
  "from": "2026-11-01T00:00:00.000Z",
  "to": "2026-11-30T23:59:59.999Z",
  "types": ["RUN", "RIDE"],
  "gearId": "0f7a...",
  "distanceMinM": 5000,
  "distanceMaxM": 25000,
  "limit": 100
}
```

The response is the same `{ items, nextCursor }` shape as the feed; pass
`cursor` in the body to fetch the next page. Invalid types/ids/ranges return
`400`. Filters are always scoped to the authenticated user, so a foreign
`gearId` simply returns no activities.

The browser client sends `fetch(..., { method: 'QUERY' })` (uppercase; Fetch
does not normalize it). The web app is same-origin, so this does not trigger a
CORS preflight; a cross-origin client would need `OPTIONS` to allow `QUERY`.
Reverse proxies and WAFs must also pass the method through rather than
rejecting it as unknown.

`GET /api/activities` remains available with the original query-string
parameters (`limit`, `cursor`, `from`, `to`, `types`, `gearId`,
`distanceMinM`, `distanceMaxM`) for the dashboard, MCP server and clients that
cannot send `QUERY`. Both routes share the same filtering and cursor logic.

## Extending the builder

A new filter needs three small additions:

1. add its id to `FILTERS` in
   `apps/web/src/components/AdvancedSearchSection.tsx`;
2. add the row control and include the value in `bodyOf` / `syncUrl`;
3. extend `activityQuerySchema` and the shared `activityFeedPage` helper in
   `apps/server/src/routes/data.ts`.

Keep filters AND-combined and URL-serialisable; that preserves the existing
share-link and cursor-pagination behaviour.
