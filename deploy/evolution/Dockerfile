# WhatsApp engine (Evolution API) for WheelDeal, built by Render from Git.
#
# IMPORTANT: the image is evoapicloud/evolution-api (the official, currently
# public image). The old atendai/evolution-api namespace was made private, which
# is why every earlier deploy failed with "not found" / "access denied" - the
# image simply could not be pulled anonymously.
FROM evoapicloud/evolution-api:v2.3.7

# PAIRING-LAYER FINGERPRINT, BAKED INTO THE IMAGE (owner report 4, anti-ban A3).
# Stock Evolution reads the linked-device fingerprint from these server env vars
# and passes them straight into makeWASocket as the client Meta sees for every
# companion device - the pairing-code path ignores the per-instance `browser`
# field entirely, so without these the code-link fingerprint falls back to
# Baileys' generic "Evolution API" default, which is the top-weighted flag
# vector AT PAIRING TIME. render.yaml sets the same pair for the Render half;
# this closes the "per-instance field may be a no-op on stock builds" gap on the
# GCP half regardless. Keep in step with CLIENT_BROWSER in src/lib/evolution.ts
# and the render.yaml env (wa/device-fingerprint.test.ts pins the agreement).
ENV CONFIG_SESSION_PHONE_CLIENT="Mac OS"
ENV CONFIG_SESSION_PHONE_NAME="Chrome"

EXPOSE 8080
