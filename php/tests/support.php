<?php

declare(strict_types=1);

namespace BizReflex\Kpax\Tests;

use BizReflex\Kpax\Exception\TransportException;
use BizReflex\Kpax\Transport\HttpRequest;
use BizReflex\Kpax\Transport\HttpResponse;
use BizReflex\Kpax\Transport\Transport;

final class AssertionFailed extends \RuntimeException
{
}

final class Assert
{
    public static function same(mixed $expected, mixed $actual, string $what = 'value'): void
    {
        if ($expected !== $actual) {
            throw new AssertionFailed(sprintf('%s: expected %s, got %s', $what, var_export($expected, true), var_export($actual, true)));
        }
    }

    public static function true(bool $condition, string $what): void
    {
        if (!$condition) {
            throw new AssertionFailed('expected true: ' . $what);
        }
    }

    /**
     * @template T of \Throwable
     *
     * @param class-string<T> $class
     *
     * @return T
     */
    public static function throws(string $class, callable $fn): \Throwable
    {
        try {
            $fn();
        } catch (\Throwable $e) {
            if ($e instanceof $class) {
                return $e;
            }
            throw new AssertionFailed(sprintf('expected %s, got %s: %s', $class, $e::class, $e->getMessage()));
        }
        throw new AssertionFailed("expected {$class}, nothing thrown");
    }
}

function fixture(string $name): mixed
{
    return json_decode((string) file_get_contents(__DIR__ . '/../../fixtures/' . $name), true, 512, JSON_THROW_ON_ERROR);
}

/** @param array<string, string> $headers */
function json(mixed $body, int $status = 200, array $headers = []): HttpResponse
{
    return new HttpResponse($status, array_change_key_case($headers, CASE_LOWER), json_encode($body, JSON_THROW_ON_ERROR));
}

/** @return array<string, string> */
function query(HttpRequest $r): array
{
    parse_str((string) parse_url($r->url, PHP_URL_QUERY), $q);

    return $q;
}

/** @return array<string, string> */
function form(?string $body): array
{
    parse_str((string) $body, $f);

    return $f;
}

/** A fake KPAX behind the Transport interface. */
final class MockKpax implements Transport
{
    /** @var list<HttpRequest> */
    public array $calls = [];
    /** @var list<array<string, string>> */
    public array $tokenRequests = [];
    /** @var callable(HttpRequest, int): HttpResponse */
    public $handler;
    /** @var (callable(): HttpResponse)|null */
    public $tokenHandler = null;
    /** @var (callable(HttpRequest): ?\Throwable)|null */
    public $fault = null;
    private int $seq = 0;

    public function __construct()
    {
        $this->handler = static fn () => json(fixture('server-status.json'));
    }

    public function send(HttpRequest $request): HttpResponse
    {
        if (parse_url($request->url, PHP_URL_PATH) === '/oauth/token') {
            $this->tokenRequests[] = form($request->body);
            if ($this->tokenHandler !== null) {
                return ($this->tokenHandler)();
            }
            $this->seq++;

            return json(['token_type' => 'Bearer', 'expires_in' => 3600, 'access_token' => "tok-{$this->seq}"]);
        }
        $this->calls[] = $request;
        if ($this->fault !== null && ($e = ($this->fault)($request)) !== null) {
            throw $e;
        }

        return ($this->handler)($request, count($this->calls));
    }
}

final class FakeClock
{
    public float $now = 1_800_000_000.0;
    /** @var list<float> */
    public array $sleeps = [];

    public function time(): float
    {
        return $this->now;
    }

    public function sleep(float $s): void
    {
        $this->sleeps[] = $s;
        $this->now += $s;
    }
}

function transportError(string $msg): TransportException
{
    return new TransportException($msg);
}
