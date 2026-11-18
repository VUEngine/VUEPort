// diagnostics for tuning on devices without developer tools (the Quest), switched on by the page's URL. Not
// translated and not offered to players

// ?perf: the speed readout also says how busy the worker was (W), which tells a machine too slow for the game from
// an audio clock running slow
export const PERF_DIAGNOSTICS =
    typeof location !== 'undefined' && new URLSearchParams(location.search).has('perf');
