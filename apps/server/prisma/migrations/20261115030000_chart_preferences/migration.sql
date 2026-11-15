-- Per-provider chart configuration for the activity page: which stream
-- charts are shown and in which order. One row per (user, provider,
-- channel); position = display order, visible = the checkbox. A
-- (user, provider) combination with no rows means "show every channel the
-- provider records, in the app's canonical order" — so the table starts
-- empty and only ever stores explicit user choices. The FK cascades so
-- account deletion removes the configuration.

CREATE TABLE "chart_channel_prefs" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider" "Provider" NOT NULL,
    "channel" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "visible" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "chart_channel_prefs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "chart_channel_prefs_user_id_provider_channel_key" ON "chart_channel_prefs"("user_id", "provider", "channel");

ALTER TABLE "chart_channel_prefs" ADD CONSTRAINT "chart_channel_prefs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
