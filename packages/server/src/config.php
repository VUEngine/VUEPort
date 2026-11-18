<?php

declare(strict_types=1);

const RA_PATH = '/ra';

// '' is treated the same as unset
function vueport_env(string $name, string $default): string
{
    $value = getenv($name);
    return $value === false || $value === '' ? $default : $value;
}
