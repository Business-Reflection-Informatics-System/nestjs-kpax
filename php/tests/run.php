<?php

declare(strict_types=1);

/*
 * Self-contained test runner (no PHPUnit needed): runs every public test* method of the
 * test classes and exits non-zero on failure.  php tests/run.php
 */

error_reporting(E_ALL);
set_error_handler(static function (int $no, string $msg, string $file, int $line): bool {
    throw new ErrorException($msg, 0, $no, $file, $line);
});

$autoload = __DIR__ . '/../vendor/autoload.php';
if (is_file($autoload)) {
    require $autoload;
} else {
    spl_autoload_register(static function (string $class): void {
        $prefix = 'BizReflex\\Kpax\\';
        if (str_starts_with($class, $prefix)) {
            $file = __DIR__ . '/../src/' . str_replace('\\', '/', substr($class, strlen($prefix))) . '.php';
            if (is_file($file)) {
                require $file;
            }
        }
    });
}
require __DIR__ . '/support.php';
require __DIR__ . '/KpaxClientTest.php';

$classes = [BizReflex\Kpax\Tests\KpaxClientTest::class];
$passed = 0;
$failed = 0;
foreach ($classes as $class) {
    $methods = array_filter(get_class_methods($class), static fn (string $m) => str_starts_with($m, 'test'));
    sort($methods);
    foreach ($methods as $method) {
        $name = (new ReflectionClass($class))->getShortName() . '.' . $method;
        try {
            (new $class())->{$method}();
            $passed++;
            echo "  PASS  {$name}\n";
        } catch (Throwable $e) {
            $failed++;
            echo "  FAIL  {$name}\n        " . $e::class . ': ' . $e->getMessage() . "\n";
        }
    }
}
echo "\n{$passed} passed, {$failed} failed, " . ($passed + $failed) . " total\n";
exit($failed === 0 ? 0 : 1);
