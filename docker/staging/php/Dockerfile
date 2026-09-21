FROM php:8.4-fpm-alpine

RUN apk add --no-cache \
    git curl libpng-dev libjpeg-turbo-dev freetype-dev \
    libzip-dev oniguruma-dev icu-dev postgresql-dev \
    postgresql-client bash linux-headers $PHPIZE_DEPS \
 && docker-php-ext-configure gd --with-freetype --with-jpeg \
 && docker-php-ext-install pdo pdo_pgsql mbstring zip exif pcntl bcmath gd intl opcache \
 && pecl install redis && docker-php-ext-enable redis \
 && apk del $PHPIZE_DEPS \
 && mv "$PHP_INI_DIR/php.ini-production" "$PHP_INI_DIR/php.ini" \
 && sed -i 's/upload_max_filesize = 2M/upload_max_filesize = 500M/g' "$PHP_INI_DIR/php.ini" \
 && sed -i 's/post_max_size = 8M/post_max_size = 500M/g' "$PHP_INI_DIR/php.ini" \
 && sed -i 's/memory_limit = 128M/memory_limit = 512M/g' "$PHP_INI_DIR/php.ini"

COPY --from=composer:2 /usr/bin/composer /usr/bin/composer

# Cria usuário com mesmo UID do host
RUN addgroup -g 1000 app && adduser -G app -g app -s /bin/sh -D -u 1000 app

WORKDIR /var/www

USER app

EXPOSE 9000
CMD ["php-fpm"]
