/**
 * Planet VB's catalog as a library shelf, with the same covers, list and game page as local folders. A hook rather
 * than a fetch, as there are two requests: the listing (title, cover, blurb) in one go, then one per game for the rest
 * (credits, year, genre, the actual ROM address), asked for a few at a time as the shelf shows them, while the cards
 * fill in.
 */
import * as React from 'react';
import { HomebrewGame, homebrewCatalog, withHomebrewDetail } from './web-homebrew';

const HYDRATE_CONCURRENCY = 4;

export interface CatalogShelf {
    games?: HomebrewGame[]; // undefined while loading
    failed: boolean;
    hydrating: boolean;
    retry(): void;
    // called with what the shelf shows first, then with the rest, so visible cards fill in first and the filter bar
    // ends up knowing the whole archive. Each game is asked once per session, so calling on every render is free
    hydrate(games: HomebrewGame[]): void;
    detail(game: HomebrewGame): Promise<HomebrewGame>;
}

export function useCatalog(active: boolean): CatalogShelf {
    const [games, setGames] = React.useState<HomebrewGame[] | undefined>();
    const [failed, setFailed] = React.useState(false);
    const [attempt, setAttempt] = React.useState(0);

    const asked = React.useRef(new Set<string>());
    const queue = React.useRef<HomebrewGame[]>([]);
    const running = React.useRef(0);
    // queue and count are refs so changing them does not redraw the shelf; only "still filling in" is mirrored into
    // state
    const [hydrating, setHydrating] = React.useState(false);
    const live = React.useRef(true);
    React.useEffect(() => () => { live.current = false; }, []);

    React.useEffect(() => {
        if (!active) {
            return undefined;
        }
        let current = true;
        setFailed(false);
        homebrewCatalog()
            .then(list => {
                if (!current) {
                    return;
                }
                // returning to the shelf fetches the bare listing again; games already in `asked` are kept so they keep
                // their score, kind and credits
                setGames(previous => {
                    const known = new Map(previous?.map(game => [game.id, game]));
                    return list.map(game => known.get(game.id) ?? game);
                });
            })
            .catch(() => { if (current) { setFailed(true); } });
        return () => { current = false; };
    }, [active, attempt]);

    const pump = React.useCallback(() => {
        setHydrating(running.current > 0 || queue.current.length > 0);
        while (running.current < HYDRATE_CONCURRENCY && queue.current.length > 0) {
            const next = queue.current.shift();
            if (!next) {
                break;
            }
            running.current++;
            withHomebrewDetail(next)
                .then(detailed => {
                    if (!live.current) {
                        return;
                    }
                    // each game replaces its own entry, so a card gains its credits without the shelf reflowing
                    setGames(current => current?.map(
                        game => (game.id === detailed.id ? detailed : game)));
                })
                .catch(() => undefined)
                .finally(() => {
                    running.current--;
                    if (live.current) {
                        pump();
                    }
                });
        }
        setHydrating(running.current > 0 || queue.current.length > 0);
    }, []);

    const hydrate = React.useCallback((wanted: HomebrewGame[]) => {
        let queued = false;
        for (const game of wanted) {
            // a game the listing already described fully needs no request; the detail call fills in exactly these
            if (asked.current.has(game.id) || game.developer) {
                continue;
            }
            asked.current.add(game.id);
            queue.current.push(game);
            queued = true;
        }
        if (queued) {
            pump();
        }
    }, [pump]);

    const detail = React.useCallback(async (game: HomebrewGame) => {
        const detailed = await withHomebrewDetail(game);
        if (live.current) {
            setGames(current => current?.map(known => (known.id === detailed.id ? detailed : known)));
        }
        return detailed;
    }, []);

    return {
        games,
        failed,
        hydrating,
        retry: () => { asked.current.clear(); setAttempt(n => n + 1); },
        hydrate,
        detail,
    };
}
