# WhatsApp engine (Evolution API) for WheelDeal, built by Render from Git.
#
# Why a Dockerfile instead of deploying the image directly: Render's "existing
# image" path validates the image with an anonymous Docker Hub pull, which hits
# rate limits and wrongly reports "No public image found". Building from this
# one-line Dockerfile pulls the image inside Render's build pipeline instead,
# which is not rate-limited - so the deploy just works.
FROM atendai/evolution-api:v2.1.1
EXPOSE 8080
