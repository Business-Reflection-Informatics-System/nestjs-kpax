<?php

declare(strict_types=1);

namespace BizReflex\Kpax\Exception;

/** A transport-level failure (DNS, connection reset, timeout). Retried for idempotent methods. */
final class TransportException extends KpaxException
{
}
