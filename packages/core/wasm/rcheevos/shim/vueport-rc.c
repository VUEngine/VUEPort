/**
 * VUEPort's shim around rcheevos' rc_client. rc_client's API is a large surface of structs, most of it more than a
 * softcore Virtual Boy integration needs. This flattens the parts VUEPort uses into functions that take and return
 * only integers, strings and byte buffers, so vb-rcheevos.ts never marshals a struct across the wasm boundary and
 * cwrap suffices.
 *
 * The host (JavaScript) implements three hooks, declared extern below and linked via --js-library (vueport-rc-lib.js):
 *
 *   vrc_read_memory  reads the emulated machine's memory. Synchronous, as rc_client evaluates a whole achievement
 *                    set's memory reads every frame, and a message round trip that often would stall the worker.
 *   vrc_server_call  makes an HTTP request. The shim never makes one itself and need not know whether it runs behind
 *                    a CORS wall or in a desktop shell that reaches RetroAchievements directly, see
 *                    emulator-retroachievements.ts.
 *   vrc_emit         hands a JSON message up to JavaScript. Every rc_client event the shim cares about becomes one,
 *                    so vb-rcheevos.ts has exactly one thing to parse.
 *
 * rc_client defaults to hardcore, and vrc_create turns it off; vrc_set_hardcore turns it back on for a player who asks.
 * That stays inert until RetroAchievements approves the VUEPort client (RETROACHIEVEMENTS_CLIENT in vb-constants.ts),
 * but the seam is here so the approval is the only thing missing.
 *
 * Leaderboards use the same hooks. Their list and entries are readable in any mode (game data and a server query),
 * but rc_client only runs a leaderboard (tracker, submission) while hardcore is on. That is RetroAchievements' own
 * rule; rc_client's state.allow_leaderboards_in_softcore would relax it and is deliberately left alone.
 */

#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <stdint.h>

#include "rc_client.h"

// ---- host-side hooks, see vueport-rc-lib.js ----

extern uint32_t vrc_read_memory(uint32_t address, uint8_t* buffer, uint32_t num_bytes);
extern void vrc_server_call(
    int request_id, const char* method, const char* url,
    const char* post_data, const char* content_type);
extern void vrc_emit(const char* json);

// ---- JSON builder ----
// not general-purpose: values are numbers or RetroAchievements' own text, which needs escaping but is never large, so
// fixed buffers do (16 KB holds any VB set's list); vrc_json_append stops writing rather than overflow

typedef struct {
  char* buffer;
  size_t capacity;
  size_t length;
} vrc_json_t;

static void vrc_json_init(vrc_json_t* json, char* buffer, size_t capacity) {
  json->buffer = buffer;
  json->capacity = capacity;
  json->length = 0;
  json->buffer[0] = '\0';
}

static void vrc_json_append(vrc_json_t* json, const char* text) {
  size_t remaining = json->capacity - json->length;
  size_t needed = strlen(text);
  if (needed >= remaining) {
    needed = remaining > 0 ? remaining - 1 : 0;
  }
  memcpy(json->buffer + json->length, text, needed);
  json->length += needed;
  json->buffer[json->length] = '\0';
}

// integral values (ids, points, timestamps) print as integers, as "%g" turned a ten-digit timestamp into "1.7e+09";
// fractions (rarity) keep "%g", which "%.17g" would print as 4.1999998092651367
static void vrc_json_number(vrc_json_t* json, double value) {
  char text[32];
  if (value >= -1e15 && value <= 1e15 && value == (double)(long long)value) {
    snprintf(text, sizeof(text), "%lld", (long long)value);
  } else {
    snprintf(text, sizeof(text), "%g", value);
  }
  vrc_json_append(json, text);
}

// every optional rc_client string reaches here as NULL when there is nothing to say, written as null
static void vrc_json_string(vrc_json_t* json, const char* text) {
  if (!text) {
    vrc_json_append(json, "null");
    return;
  }
  vrc_json_append(json, "\"");
  char escaped[2];
  escaped[1] = '\0';
  for (const unsigned char* p = (const unsigned char*)text; *p; p++) {
    if (*p == '"' || *p == '\\') {
      escaped[0] = '\\';
      vrc_json_append(json, escaped);
      escaped[0] = (char)*p;
      vrc_json_append(json, escaped);
    } else if (*p == '\n') {
      vrc_json_append(json, "\\n");
    } else if (*p < 0x20) {
      char code[8];
      snprintf(code, sizeof(code), "\\u%04x", *p);
      vrc_json_append(json, code);
    } else {
      escaped[0] = (char)*p;
      vrc_json_append(json, escaped);
    }
  }
  vrc_json_append(json, "\"");
}

// ---- pending server calls ----
// rc_client wants its callback and callback_data back whenever vrc_provide_response is called, this tick or seconds
// later. A fixed table keyed by request id suffices, as RetroAchievements sends a request every few seconds at most

#define VRC_MAX_PENDING_CALLS 32

typedef struct {
  int in_use;
  int id;
  rc_client_server_callback_t callback;
  void* callback_data;
} vrc_pending_call_t;

static vrc_pending_call_t vrc_pending_calls[VRC_MAX_PENDING_CALLS];
static int vrc_next_request_id = 1;

static void vrc_server_call_impl(
    const rc_api_request_t* request,
    rc_client_server_callback_t callback,
    void* callback_data,
    rc_client_t* client) {
  (void)client;

  int slot = -1;
  for (int i = 0; i < VRC_MAX_PENDING_CALLS; i++) {
    if (!vrc_pending_calls[i].in_use) {
      slot = i;
      break;
    }
  }
  if (slot < 0) {
    // all slots busy, which should never happen: a client error is something rc_client's own retry logic handles
    rc_api_server_response_t response;
    memset(&response, 0, sizeof(response));
    response.http_status_code = RC_API_SERVER_RESPONSE_RETRYABLE_CLIENT_ERROR;
    callback(&response, callback_data);
    return;
  }

  int id = vrc_next_request_id++;
  vrc_pending_calls[slot].in_use = 1;
  vrc_pending_calls[slot].id = id;
  vrc_pending_calls[slot].callback = callback;
  vrc_pending_calls[slot].callback_data = callback_data;

  vrc_server_call(
      id,
      request->post_data ? "POST" : "GET",
      request->url,
      request->post_data,
      request->content_type);
}

void vrc_provide_response(int request_id, int status, const char* body) {
  for (int i = 0; i < VRC_MAX_PENDING_CALLS; i++) {
    if (vrc_pending_calls[i].in_use && vrc_pending_calls[i].id == request_id) {
      rc_api_server_response_t response;
      memset(&response, 0, sizeof(response));
      response.body = body;
      response.body_length = body ? strlen(body) : 0;
      response.http_status_code = status;
      vrc_pending_calls[i].in_use = 0;
      vrc_pending_calls[i].callback(&response, vrc_pending_calls[i].callback_data);
      return;
    }
  }
  // a response for a request nobody waits on any more (session reset or game unloaded meanwhile): nothing to do
}

// ---- memory ----

static uint32_t vrc_read_memory_impl(
    uint32_t address, uint8_t* buffer, uint32_t num_bytes, rc_client_t* client) {
  (void)client;
  return vrc_read_memory(address, buffer, num_bytes);
}

// ---- achievement list ----
// sent whole rather than as a diff: a VB set is a handful of achievements, so this is cheap and the page never has to
// reassemble a list from partial updates

static void vrc_append_achievement(vrc_json_t* json, const rc_client_achievement_t* achievement) {
  vrc_json_append(json, "{\"id\":");
  vrc_json_number(json, achievement->id);
  vrc_json_append(json, ",\"title\":");
  vrc_json_string(json, achievement->title);
  vrc_json_append(json, ",\"desc\":");
  vrc_json_string(json, achievement->description);
  vrc_json_append(json, ",\"points\":");
  vrc_json_number(json, achievement->points);
  vrc_json_append(json, ",\"badge\":");
  vrc_json_string(json, achievement->state == RC_CLIENT_ACHIEVEMENT_STATE_UNLOCKED
      ? achievement->badge_url : achievement->badge_locked_url);
  vrc_json_append(json, ",\"state\":");
  vrc_json_string(json,
      achievement->state == RC_CLIENT_ACHIEVEMENT_STATE_DISABLED ? "unsupported"
      : achievement->state == RC_CLIENT_ACHIEVEMENT_STATE_UNLOCKED ? "unlocked"
      : "locked");
  vrc_json_append(json, ",\"hardcore\":");
  vrc_json_append(json, (achievement->unlocked & RC_CLIENT_ACHIEVEMENT_UNLOCKED_HARDCORE) ? "true" : "false");
  vrc_json_append(json, ",\"bucket\":");
  vrc_json_number(json, achievement->bucket);
  // the detail view's extras, all filled in by the same load. type is sent only when not STANDARD (Missable,
  // Progression, Win Condition); rarity is the site's "% of players who earned this", present only once there are
  // enough unlocks; unlock_time is 0 until unlocked
  if (achievement->type != RC_CLIENT_ACHIEVEMENT_TYPE_STANDARD) {
    vrc_json_append(json, ",\"type\":");
    vrc_json_number(json, achievement->type);
  }
  if (achievement->rarity > 0.0f) {
    vrc_json_append(json, ",\"rarity\":");
    vrc_json_number(json, achievement->rarity);
    vrc_json_append(json, ",\"rarityHardcore\":");
    vrc_json_number(json, achievement->rarity_hardcore);
  }
  if (achievement->unlock_time > 0) {
    vrc_json_append(json, ",\"unlockTime\":");
    vrc_json_number(json, (double)achievement->unlock_time);
  }
  if (achievement->measured_progress[0] != '\0') {
    // rc_client already tracks the fraction as a percentage, simpler than parsing "12/50" back apart in JS
    vrc_json_append(json, ",\"measured\":{\"percent\":");
    vrc_json_number(json, achievement->measured_percent);
    vrc_json_append(json, ",\"display\":");
    vrc_json_string(json, achievement->measured_progress);
    vrc_json_append(json, "}");
  }
  vrc_json_append(json, "}");
}

void vrc_emit_achievement_list(rc_client_t* client) {
  static char buffer[16384];
  vrc_json_t json;
  vrc_json_init(&json, buffer, sizeof(buffer));

  vrc_json_append(&json, "{\"t\":\"achlist\",\"achievements\":[");

  rc_client_achievement_list_t* list = rc_client_create_achievement_list(
      client, RC_CLIENT_ACHIEVEMENT_CATEGORY_CORE, RC_CLIENT_ACHIEVEMENT_LIST_GROUPING_LOCK_STATE);
  if (list) {
    int first = 1;
    for (uint32_t b = 0; b < list->num_buckets; b++) {
      const rc_client_achievement_bucket_t* bucket = &list->buckets[b];
      for (uint32_t a = 0; a < bucket->num_achievements; a++) {
        if (!first) {
          vrc_json_append(&json, ",");
        }
        first = 0;
        vrc_append_achievement(&json, bucket->achievements[a]);
      }
    }
    rc_client_destroy_achievement_list(list);
  }

  vrc_json_append(&json, "]}");
  vrc_emit(buffer);
}

// ---- leaderboard list ----
// sent whole when a set loads and on every attempt start, fail or submit; tracker updates are many per second and
// travel as their own small message

static const char* vrc_leaderboard_state_name(uint8_t state) {
  switch (state) {
    case RC_CLIENT_LEADERBOARD_STATE_ACTIVE: return "active";
    case RC_CLIENT_LEADERBOARD_STATE_TRACKING: return "tracking";
    case RC_CLIENT_LEADERBOARD_STATE_DISABLED: return "unsupported";
    default: return "inactive";
  }
}

// rc_client has already formatted every value; this only lets the panel label a column and pick an icon
static const char* vrc_leaderboard_format_name(uint8_t format) {
  switch (format) {
    case RC_CLIENT_LEADERBOARD_FORMAT_TIME: return "time";
    case RC_CLIENT_LEADERBOARD_FORMAT_VALUE: return "value";
    default: return "score";
  }
}

static void vrc_append_leaderboard(vrc_json_t* json, const rc_client_leaderboard_t* leaderboard) {
  vrc_json_append(json, "{\"id\":");
  vrc_json_number(json, leaderboard->id);
  vrc_json_append(json, ",\"title\":");
  vrc_json_string(json, leaderboard->title);
  vrc_json_append(json, ",\"desc\":");
  vrc_json_string(json, leaderboard->description);
  vrc_json_append(json, ",\"format\":");
  vrc_json_string(json, vrc_leaderboard_format_name(leaderboard->format));
  vrc_json_append(json, ",\"lower\":");
  vrc_json_append(json, leaderboard->lower_is_better ? "true" : "false");
  vrc_json_append(json, ",\"state\":");
  vrc_json_string(json, vrc_leaderboard_state_name(leaderboard->state));
  if (leaderboard->state == RC_CLIENT_LEADERBOARD_STATE_TRACKING && leaderboard->tracker_value) {
    vrc_json_append(json, ",\"value\":");
    vrc_json_string(json, leaderboard->tracker_value);
  }
  vrc_json_append(json, "}");
}

void vrc_emit_leaderboard_list(rc_client_t* client) {
  static char buffer[16384];
  vrc_json_t json;
  vrc_json_init(&json, buffer, sizeof(buffer));

  vrc_json_append(&json, "{\"t\":\"lblist\",\"leaderboards\":[");

  // GROUPING_NONE: each leaderboard carries its own state, which is what the panel groups on
  rc_client_leaderboard_list_t* list = rc_client_create_leaderboard_list(
      client, RC_CLIENT_LEADERBOARD_LIST_GROUPING_NONE);
  if (list) {
    int first = 1;
    for (uint32_t b = 0; b < list->num_buckets; b++) {
      const rc_client_leaderboard_bucket_t* bucket = &list->buckets[b];
      for (uint32_t l = 0; l < bucket->num_leaderboards; l++) {
        if (!first) {
          vrc_json_append(&json, ",");
        }
        first = 0;
        vrc_append_leaderboard(&json, bucket->leaderboards[l]);
      }
    }
    rc_client_destroy_leaderboard_list(list);
  }

  vrc_json_append(&json, "]}");
  vrc_emit(buffer);
}

// ---- leaderboard entries ----
// a server query, so a request/answer pair: the host's fetch_id comes back on "lbentries", settling the panel's
// promise in vb-rcheevos.ts. It rides in rc_client's callback_userdata pointer, as nothing else has to survive the trip

// a page of a hundred entries with room to spare; the host asks for far fewer (VRC_MAX_ENTRIES in vb-rcheevos.ts)
static char vrc_entries_buffer[65536];

static void vrc_fetch_entries_callback(
    int result, const char* error_message,
    rc_client_leaderboard_entry_list_t* list, rc_client_t* client, void* callback_userdata) {
  (void)client;
  int fetch_id = (int)(intptr_t)callback_userdata;

  vrc_json_t json;
  vrc_json_init(&json, vrc_entries_buffer, sizeof(vrc_entries_buffer));

  if (result != RC_OK || !list) {
    vrc_json_append(&json, "{\"t\":\"lbentries\",\"fetch\":");
    vrc_json_number(&json, fetch_id);
    vrc_json_append(&json, ",\"ok\":false,\"err\":");
    vrc_json_string(&json, error_message ? error_message
        : "RetroAchievements did not answer with this leaderboard's entries.");
    vrc_json_append(&json, "}");
    vrc_emit(vrc_entries_buffer);
    if (list) {
      rc_client_destroy_leaderboard_entry_list(list);
    }
    return;
  }

  vrc_json_append(&json, "{\"t\":\"lbentries\",\"fetch\":");
  vrc_json_number(&json, fetch_id);
  vrc_json_append(&json, ",\"ok\":true,\"total\":");
  vrc_json_number(&json, list->total_entries);
  // -1 when the page does not contain the signed-in player, the ordinary case for the top of a board
  vrc_json_append(&json, ",\"userIndex\":");
  vrc_json_number(&json, list->user_index);
  vrc_json_append(&json, ",\"entries\":[");

  for (uint32_t i = 0; i < list->num_entries; i++) {
    const rc_client_leaderboard_entry_t* entry = &list->entries[i];
    if (i > 0) {
      vrc_json_append(&json, ",");
    }
    vrc_json_append(&json, "{\"rank\":");
    vrc_json_number(&json, entry->rank);
    vrc_json_append(&json, ",\"user\":");
    vrc_json_string(&json, entry->user);
    vrc_json_append(&json, ",\"display\":");
    vrc_json_string(&json, entry->display);
    vrc_json_append(&json, ",\"submitted\":");
    vrc_json_number(&json, (double)entry->submitted);
    char avatar[256];
    if (rc_client_leaderboard_entry_get_user_image_url(entry, avatar, sizeof(avatar)) == RC_OK) {
      vrc_json_append(&json, ",\"avatar\":");
      vrc_json_string(&json, avatar);
    }
    vrc_json_append(&json, "}");
  }

  vrc_json_append(&json, "]}");
  vrc_emit(vrc_entries_buffer);
  rc_client_destroy_leaderboard_entry_list(list);
}

// around_user asks for the page the signed-in player sits in (another endpoint, same answer shape) and ignores
// first_entry, which is 1-based. Always answers with "lbentries", errors too, so the host never waits forever
void vrc_begin_fetch_leaderboard_entries(
    rc_client_t* client, int fetch_id, uint32_t leaderboard_id,
    uint32_t first_entry, uint32_t count, int around_user) {
  void* userdata = (void*)(intptr_t)fetch_id;
  if (around_user) {
    rc_client_begin_fetch_leaderboard_entries_around_user(
        client, leaderboard_id, count, vrc_fetch_entries_callback, userdata);
  } else {
    rc_client_begin_fetch_leaderboard_entries(
        client, leaderboard_id, first_entry, count, vrc_fetch_entries_callback, userdata);
  }
}

// ---- event handler ----
// one message per event; rich presence is not forwarded, as VUEPort has nowhere to show it

static void vrc_on_event(const rc_client_event_t* event, rc_client_t* client) {
  static char buffer[4096];
  vrc_json_t json;

  switch (event->type) {
    case RC_CLIENT_EVENT_ACHIEVEMENT_TRIGGERED: {
      const rc_client_achievement_t* achievement = event->achievement;
      vrc_json_init(&json, buffer, sizeof(buffer));
      vrc_json_append(&json, "{\"t\":\"unlock\",\"id\":");
      vrc_json_number(&json, achievement->id);
      vrc_json_append(&json, ",\"title\":");
      vrc_json_string(&json, achievement->title);
      vrc_json_append(&json, ",\"desc\":");
      vrc_json_string(&json, achievement->description);
      vrc_json_append(&json, ",\"points\":");
      vrc_json_number(&json, achievement->points);
      vrc_json_append(&json, ",\"badge\":");
      vrc_json_string(&json, achievement->badge_url);
      vrc_json_append(&json, ",\"hardcore\":");
      vrc_json_append(&json, rc_client_get_hardcore_enabled(client) ? "true" : "false");
      vrc_json_append(&json, "}");
      vrc_emit(buffer);
      vrc_emit_achievement_list(client);
      return;
    }
    case RC_CLIENT_EVENT_ACHIEVEMENT_CHALLENGE_INDICATOR_SHOW:
    case RC_CLIENT_EVENT_ACHIEVEMENT_CHALLENGE_INDICATOR_HIDE: {
      const rc_client_achievement_t* achievement = event->achievement;
      vrc_json_init(&json, buffer, sizeof(buffer));
      vrc_json_append(&json, "{\"t\":\"challenge\",\"id\":");
      vrc_json_number(&json, achievement->id);
      vrc_json_append(&json, ",\"show\":");
      vrc_json_append(&json, event->type == RC_CLIENT_EVENT_ACHIEVEMENT_CHALLENGE_INDICATOR_SHOW ? "true" : "false");
      vrc_json_append(&json, ",\"badge\":");
      vrc_json_string(&json, achievement->badge_url);
      vrc_json_append(&json, "}");
      vrc_emit(buffer);
      return;
    }
    case RC_CLIENT_EVENT_ACHIEVEMENT_PROGRESS_INDICATOR_UPDATE:
      vrc_emit_achievement_list(client);
      return;
    case RC_CLIENT_EVENT_LEADERBOARD_STARTED:
    case RC_CLIENT_EVENT_LEADERBOARD_FAILED:
    case RC_CLIENT_EVENT_LEADERBOARD_SUBMITTED: {
      const rc_client_leaderboard_t* leaderboard = event->leaderboard;
      vrc_json_init(&json, buffer, sizeof(buffer));
      vrc_json_append(&json, "{\"t\":\"lbattempt\",\"id\":");
      vrc_json_number(&json, leaderboard->id);
      vrc_json_append(&json, ",\"title\":");
      vrc_json_string(&json, leaderboard->title);
      vrc_json_append(&json, ",\"desc\":");
      vrc_json_string(&json, leaderboard->description);
      vrc_json_append(&json, ",\"state\":");
      vrc_json_string(&json,
          event->type == RC_CLIENT_EVENT_LEADERBOARD_STARTED ? "started"
          : event->type == RC_CLIENT_EVENT_LEADERBOARD_FAILED ? "failed"
          : "submitted");
      // the value the attempt ended on; rc_client leaves it standing until the next attempt
      if (leaderboard->tracker_value) {
        vrc_json_append(&json, ",\"value\":");
        vrc_json_string(&json, leaderboard->tracker_value);
      }
      vrc_json_append(&json, "}");
      vrc_emit(buffer);
      vrc_emit_leaderboard_list(client);
      return;
    }
    case RC_CLIENT_EVENT_LEADERBOARD_TRACKER_SHOW:
    case RC_CLIENT_EVENT_LEADERBOARD_TRACKER_HIDE:
    case RC_CLIENT_EVENT_LEADERBOARD_TRACKER_UPDATE: {
      // several leaderboards showing the same value share one tracker, so `id` is the tracker's and the overlay keys on
      // it
      const rc_client_leaderboard_tracker_t* tracker = event->leaderboard_tracker;
      vrc_json_init(&json, buffer, sizeof(buffer));
      vrc_json_append(&json, "{\"t\":\"lbtrack\",\"id\":");
      vrc_json_number(&json, tracker->id);
      vrc_json_append(&json, ",\"show\":");
      vrc_json_append(&json, event->type == RC_CLIENT_EVENT_LEADERBOARD_TRACKER_HIDE ? "false" : "true");
      vrc_json_append(&json, ",\"display\":");
      vrc_json_string(&json, tracker->display);
      vrc_json_append(&json, "}");
      vrc_emit(buffer);
      return;
    }
    case RC_CLIENT_EVENT_LEADERBOARD_SCOREBOARD: {
      // only valid for the length of this call, so everything wanted is copied out here
      const rc_client_leaderboard_scoreboard_t* scoreboard = event->leaderboard_scoreboard;
      vrc_json_init(&json, buffer, sizeof(buffer));
      vrc_json_append(&json, "{\"t\":\"lbboard\",\"id\":");
      vrc_json_number(&json, scoreboard->leaderboard_id);
      vrc_json_append(&json, ",\"submitted\":");
      vrc_json_string(&json, scoreboard->submitted_score);
      vrc_json_append(&json, ",\"best\":");
      vrc_json_string(&json, scoreboard->best_score);
      vrc_json_append(&json, ",\"rank\":");
      vrc_json_number(&json, scoreboard->new_rank);
      vrc_json_append(&json, ",\"total\":");
      vrc_json_number(&json, scoreboard->num_entries);
      vrc_json_append(&json, ",\"top\":[");
      for (uint32_t i = 0; i < scoreboard->num_top_entries; i++) {
        const rc_client_leaderboard_scoreboard_entry_t* top = &scoreboard->top_entries[i];
        if (i > 0) {
          vrc_json_append(&json, ",");
        }
        vrc_json_append(&json, "{\"rank\":");
        vrc_json_number(&json, top->rank);
        vrc_json_append(&json, ",\"user\":");
        vrc_json_string(&json, top->username);
        vrc_json_append(&json, ",\"score\":");
        vrc_json_string(&json, top->score);
        vrc_json_append(&json, "}");
      }
      vrc_json_append(&json, "]}");
      vrc_emit(buffer);
      return;
    }
    case RC_CLIENT_EVENT_DISCONNECTED:
      vrc_emit("{\"t\":\"conn\",\"online\":false}");
      return;
    case RC_CLIENT_EVENT_RECONNECTED:
      vrc_emit("{\"t\":\"conn\",\"online\":true}");
      return;
    default:
      // RESET, GAME_COMPLETED, SUBSET_COMPLETED and SERVER_ERROR (rc_client has given up retrying) are not acted on yet
      return;
  }
}

// ---- lifecycle ----

rc_client_t* vrc_create(void) {
  rc_client_t* client = rc_client_create(vrc_read_memory_impl, vrc_server_call_impl);
  if (!client) {
    return NULL;
  }
  // rc_client defaults to hardcore; VUEPort is softcore-only until RetroAchievements approves it
  // (RETROACHIEVEMENTS_CLIENT in vb-constants.ts)
  rc_client_set_hardcore_enabled(client, 0);
  rc_client_set_event_handler(client, vrc_on_event);
  rc_client_set_read_memory_function(client, vrc_read_memory_impl);
  return client;
}

void vrc_destroy(rc_client_t* client) {
  if (client) {
    rc_client_destroy(client);
  }
}

static void vrc_login_callback(int result, const char* error_message, rc_client_t* client, void* userdata) {
  (void)userdata;
  static char buffer[1024];
  vrc_json_t json;
  vrc_json_init(&json, buffer, sizeof(buffer));

  if (result != RC_OK) {
    vrc_json_append(&json, "{\"t\":\"login\",\"ok\":false,\"err\":");
    vrc_json_string(&json, error_message);
    vrc_json_append(&json, "}");
    vrc_emit(buffer);
    return;
  }

  const rc_client_user_t* user = rc_client_get_user_info(client);
  vrc_json_append(&json, "{\"t\":\"login\",\"ok\":true,\"user\":{\"username\":");
  vrc_json_string(&json, user ? user->username : NULL);
  vrc_json_append(&json, ",\"display\":");
  vrc_json_string(&json, user ? user->display_name : NULL);
  vrc_json_append(&json, ",\"token\":");
  vrc_json_string(&json, user ? user->token : NULL);
  vrc_json_append(&json, ",\"score\":");
  vrc_json_number(&json, user ? user->score : 0);
  vrc_json_append(&json, ",\"softcore\":");
  vrc_json_number(&json, user ? user->score_softcore : 0);
  if (user && user->avatar_url) {
    vrc_json_append(&json, ",\"avatar\":");
    vrc_json_string(&json, user->avatar_url);
  }
  vrc_json_append(&json, "}}");
  vrc_emit(buffer);
}

void vrc_begin_login_password(rc_client_t* client, const char* username, const char* password) {
  rc_client_begin_login_with_password(client, username, password, vrc_login_callback, NULL);
}

void vrc_begin_login_token(rc_client_t* client, const char* username, const char* token) {
  rc_client_begin_login_with_token(client, username, token, vrc_login_callback, NULL);
}

void vrc_logout(rc_client_t* client) {
  rc_client_logout(client);
}

static void vrc_load_game_callback(int result, const char* error_message, rc_client_t* client, void* userdata) {
  (void)userdata;
  static char buffer[1024];
  vrc_json_t json;
  vrc_json_init(&json, buffer, sizeof(buffer));

  if (result != RC_OK || !rc_client_is_game_loaded(client)) {
    vrc_json_append(&json, "{\"t\":\"load\",\"ok\":false,\"err\":");
    vrc_json_string(&json, error_message ? error_message
        : "RetroAchievements has no achievement set for this ROM.");
    vrc_json_append(&json, "}");
    vrc_emit(buffer);
    return;
  }

  const rc_client_game_t* game = rc_client_get_game_info(client);
  rc_client_user_game_summary_t summary;
  rc_client_get_user_game_summary(client, &summary);

  vrc_json_append(&json, "{\"t\":\"load\",\"ok\":true,\"game\":{\"id\":");
  vrc_json_number(&json, game ? game->id : 0);
  vrc_json_append(&json, ",\"title\":");
  vrc_json_string(&json, game ? game->title : NULL);
  vrc_json_append(&json, ",\"icon\":");
  vrc_json_string(&json, game ? game->badge_url : NULL);
  vrc_json_append(&json, ",\"count\":");
  vrc_json_number(&json, summary.num_core_achievements);
  vrc_json_append(&json, ",\"points\":");
  vrc_json_number(&json, summary.points_core);
  vrc_json_append(&json, "}}");
  vrc_emit(buffer);

  vrc_emit_achievement_list(client);
  // even for a game with none: an empty list tells the panel to stop showing it as loading
  vrc_emit_leaderboard_list(client);
}

void vrc_begin_load_game(rc_client_t* client, const char* hash) {
  rc_client_begin_load_game(client, hash, vrc_load_game_callback, NULL);
}

void vrc_unload_game(rc_client_t* client) {
  rc_client_unload_game(client);
}

void vrc_reset(rc_client_t* client) {
  rc_client_reset(client);
}

// raised by the host once the client is approved and the user asks for hardcore; called before vrc_begin_load_game so a
// set loads in the right mode
void vrc_set_hardcore(rc_client_t* client, int enabled) {
  rc_client_set_hardcore_enabled(client, enabled ? 1 : 0);
  // hardcore activates leaderboards, so every one of them just changed state
  if (rc_client_is_game_loaded(client)) {
    vrc_emit_leaderboard_list(client);
  }
}

void vrc_do_frame(rc_client_t* client) {
  rc_client_do_frame(client);
}

void vrc_idle(rc_client_t* client) {
  rc_client_idle(client);
}
