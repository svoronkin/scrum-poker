FROM docker.io/library/python:3.12-alpine

WORKDIR /app

RUN adduser -D -u 1000 poker \
    && mkdir -p /app/data \
    && chown poker:poker /app/data

COPY --chown=poker:poker server.py /app/server.py
COPY --chown=poker:poker public /app/public

USER poker
EXPOSE 8080
ENV PYTHONUNBUFFERED=1
VOLUME /app/data

CMD ["python3", "server.py"]
