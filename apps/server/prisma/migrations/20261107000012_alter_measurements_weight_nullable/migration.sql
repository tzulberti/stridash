-- Wide-table rule: `measurements` rows discriminated by `kind`; non-applicable
-- columns must be NULL-able. weight_kg was missing the `?` — blood-pressure
-- monitor rows would have been impossible.
ALTER TABLE "measurements" ALTER COLUMN "weight_kg" DROP NOT NULL;
