<?php

declare(strict_types=1);

namespace BizReflex\Kpax\Model;

/** @internal */
final class Convert
{
    /** KPAX ids arrive as numbers or numeric strings (B18). */
    public static function int(mixed $v): ?int
    {
        if ($v === null || $v === '' || is_bool($v)) {
            return null;
        }
        if (is_int($v)) {
            return $v;
        }
        if (is_float($v)) {
            return (int) $v;
        }
        $s = trim((string) $v);

        return is_numeric($s) ? (int) $s : null;
    }

    public static function str(mixed $v): ?string
    {
        return $v === null ? null : (string) $v;
    }
}
