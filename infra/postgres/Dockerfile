FROM postgres:16.15-alpine

RUN sed -i 's/dl-cdn.alpinelinux.org/mirrors.aliyun.com/g' /etc/apk/repositories && \
    apk add --no-cache --virtual .build-deps git gcc musl-dev make && \
    git clone --depth 1 --branch v0.8.0 https://github.com/pgvector/pgvector.git /tmp/pgvector && \
    cd /tmp/pgvector && \
    make with_llvm=no OPTFLAGS="" && \
    make with_llvm=no install && \
    cd / && \
    rm -rf /tmp/pgvector && \
    apk del .build-deps
