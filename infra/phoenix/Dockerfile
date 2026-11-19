FROM public.ecr.aws/docker/library/python:3.11-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PHOENIX_HOST=0.0.0.0 \
    PHOENIX_PORT=6006 \
    PHOENIX_GRPC_PORT=4317 \
    PHOENIX_WORKING_DIR=/mnt/data

RUN pip install --no-cache-dir -i https://mirrors.aliyun.com/pypi/simple/ --trusted-host mirrors.aliyun.com arize-phoenix

EXPOSE 6006 4317

CMD ["phoenix", "serve"]
