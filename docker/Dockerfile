# 🔺 digest-pinned: a floating tag lets the host and CI build from different bytes for one
# commit, which makes a ci-local receipt meaningless. Bump deliberately, never by rebuilding.
FROM nginx:alpine@sha256:db35bfc6b2951e7f8a72db5db120288c127ffaeeb4a6d4b95a26fead017d5913

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY src/ /usr/share/nginx/html/

EXPOSE 80
