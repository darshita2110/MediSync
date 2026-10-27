CREATE TABLE push_devices (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  secret_hash TEXT NOT NULL CHECK (length(secret_hash) = 64),
  binding_id UUID NOT NULL,
  token TEXT NOT NULL UNIQUE CHECK (length(token) BETWEEN 20 AND 4096),
  platform TEXT NOT NULL CHECK (platform = 'android'),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_active_push_devices ON push_devices(user_id) WHERE active;

CREATE TABLE push_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id UUID NOT NULL REFERENCES care_notifications(id) ON DELETE CASCADE,
  device_id UUID NOT NULL REFERENCES push_devices(id) ON DELETE CASCADE,
  binding_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'accepted', 'cancelled', 'failed')),
  attempts SMALLINT NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 6),
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_id UUID,
  lease_until TIMESTAMPTZ,
  accepted_at TIMESTAMPTZ,
  last_error TEXT,
  UNIQUE (notification_id, device_id, binding_id),
  CHECK ((status = 'sending' AND lease_id IS NOT NULL AND lease_until IS NOT NULL) OR
         (status <> 'sending' AND lease_id IS NULL AND lease_until IS NULL))
);
CREATE INDEX idx_push_delivery_queue ON push_deliveries(available_at, id) WHERE status IN ('pending', 'sending');
