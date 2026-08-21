# Tiny psql runner for the wd-evo-prune cron (owner report 6, J4).
FROM postgres:16-alpine
COPY prune.sh /prune.sh
RUN chmod +x /prune.sh
CMD ["/prune.sh"]
