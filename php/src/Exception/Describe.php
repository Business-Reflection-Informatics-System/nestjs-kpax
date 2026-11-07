<?php

declare(strict_types=1);

namespace BizReflex\Kpax\Exception;

/** @internal */
final class Describe
{
    public static function body(mixed $body): string
    {
        if ($body === null || $body === '') {
            return '';
        }
        if (is_string($body)) {
            return ': ' . substr($body, 0, 300);
        }
        if (is_array($body)) {
            foreach (['message', 'error_description', 'error'] as $key) {
                if (isset($body[$key]) && is_string($body[$key])) {
                    return ': ' . $body[$key];
                }
            }
        }
        $json = json_encode($body);

        return $json === false ? '' : ': ' . substr($json, 0, 300);
    }
}
