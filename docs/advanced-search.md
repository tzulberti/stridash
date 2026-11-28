# Advanced activity search

The web app's `/search` page is a small query builder for the activity history.
Every condition is combined with **AND**; an empty condition is simply ignored.

## Filters

| Filter | UI | API parameters |
|---|---|---|
| Date range | start date, end date (either side optional) | `from`, `to` (ISO datetimes) |
| Activity types | multi-select chips (RUN, RIDE, VIRTUAL_RIDE, WALK, HIKE, SWIM, WORKOUT, OTHER) | `types=RUN,RIDE` |
| Gear | one gear item, or any gear | `gearId=<uuid>` |
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

`GET /api/activities` accepts the existing `limit`, `cursor`, `from` and `to`
parameters plus:

```text
types=RUN,RIDE
gearId=0f7a...
distanceMinM=5000
distanceMaxM=25000
```

Invalid types/ids/ranges return `400`. Filters are always scoped to the
authenticated user, so a foreign `gearId` simply returns no activities.

## Extending the builder

A new filter needs three small additions:

1. add its id to `FILTERS` in
   `apps/web/src/components/AdvancedSearchSection.tsx`;
2. add the row control and include the value in `queryOf` / `syncUrl`;
3. extend `listQuerySchema` and the Prisma `where` clause in
   `apps/server/src/routes/data.ts`.

Keep filters AND-combined and URL-serialisable; that preserves the existing
share-link and cursor-pagination behaviour.
