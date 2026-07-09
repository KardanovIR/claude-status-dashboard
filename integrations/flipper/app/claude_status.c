/**
 * Claude Status — a Flipper Zero display for Claude Code task statuses.
 *
 * The app hijacks the Flipper's built-in BLE *serial* profile and acts as a
 * peripheral. A host daemon (../../daemon) connects as central and writes
 * newline-terminated frames describing up to MAX_TASKS rows. We parse each
 * frame and render it on screen.
 *
 * Wire frame (see daemon/src/select.ts — must stay in sync):
 *   <count>\x1e<code>\x1f<name>\x1f<msg>\x1e<code>\x1f<name>\x1f<msg>...\n
 *   code: i idle | p planning | c coding | t testing | b blocked | d done
 */

#include <furi.h>
#include <furi_hal_bt.h>
#include <gui/gui.h>
#include <input/input.h>
#include <bt/bt_service/bt.h>
#include <profiles/serial_profile.h>

#include <string.h>

#define TAG "ClaudeStatus"

#define MAX_TASKS 4
#define NAME_LEN  16
#define MSG_LEN   28
#define RX_BUF    256

#define RS_CHAR '\x1e' // record separator (between rows)
#define FS_CHAR '\x1f' // field separator (between fields)

#define KEYS_STORAGE_NAME "claude_status.keys"

typedef struct {
    char status; // one-char status code
    char name[NAME_LEN];
    char msg[MSG_LEN];
} TaskRow;

typedef struct {
    Gui* gui;
    ViewPort* view_port;
    FuriMessageQueue* input_queue;
    FuriMutex* mutex;

    Bt* bt;
    FuriHalBleProfileBase* profile;

    // Model (guarded by mutex)
    TaskRow rows[MAX_TASKS];
    uint8_t count;
    bool connected;

    // Serial RX line accumulator (only touched from the BT callback thread)
    uint8_t rx_accum[RX_BUF];
    size_t rx_len;
} App;

// ---------------------------------------------------------------------------
// Frame parsing
// ---------------------------------------------------------------------------

static void parse_line(App* app, char* line) {
    furi_mutex_acquire(app->mutex, FuriWaitForever);
    app->count = 0;

    // First field (before the first RS) is the count — we don't need it, the
    // record loop naturally caps at MAX_TASKS.
    char* rs = strchr(line, RS_CHAR);
    char* p = rs ? rs + 1 : NULL;

    while(p && *p && app->count < MAX_TASKS) {
        char* next = strchr(p, RS_CHAR);
        size_t reclen = next ? (size_t)(next - p) : strlen(p);

        char rec[NAME_LEN + MSG_LEN + 8];
        size_t n = reclen < sizeof(rec) - 1 ? reclen : sizeof(rec) - 1;
        memcpy(rec, p, n);
        rec[n] = '\0';

        // Split record into code \x1f name \x1f msg
        char* code = rec;
        char* name = NULL;
        char* msg = NULL;
        char* fs = strchr(code, FS_CHAR);
        if(fs) {
            *fs = '\0';
            name = fs + 1;
            fs = strchr(name, FS_CHAR);
            if(fs) {
                *fs = '\0';
                msg = fs + 1;
            }
        }

        TaskRow* row = &app->rows[app->count];
        memset(row, 0, sizeof(*row));
        row->status = code[0] ? code[0] : '?';
        if(name) strncpy(row->name, name, NAME_LEN - 1);
        if(msg) strncpy(row->msg, msg, MSG_LEN - 1);
        app->count++;

        if(!next) break;
        p = next + 1;
    }

    furi_mutex_release(app->mutex);
    view_port_update(app->view_port);
}

// ---------------------------------------------------------------------------
// BLE serial callbacks (run on the system BT thread)
// ---------------------------------------------------------------------------

static uint16_t serial_event_callback(SerialServiceEvent event, void* context) {
    App* app = context;
    if(event.event == SerialServiceEventTypeDataReceived) {
        for(uint16_t i = 0; i < event.data.size; i++) {
            char b = (char)event.data.buffer[i];
            if(b == '\n') {
                app->rx_accum[app->rx_len] = '\0';
                parse_line(app, (char*)app->rx_accum);
                app->rx_len = 0;
            } else if(app->rx_len < sizeof(app->rx_accum) - 1) {
                app->rx_accum[app->rx_len++] = (uint8_t)b;
            } else {
                // Overflow without a newline — drop the partial line.
                app->rx_len = 0;
            }
        }
    }
    return (uint16_t)sizeof(app->rx_accum);
}

static void bt_status_callback(BtStatus status, void* context) {
    App* app = context;
    furi_mutex_acquire(app->mutex, FuriWaitForever);
    app->connected = (status == BtStatusConnected);
    furi_mutex_release(app->mutex);
    view_port_update(app->view_port);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

static char status_letter(char code) {
    if(code >= 'a' && code <= 'z') return (char)(code - 32);
    return code ? code : '?';
}

static void draw_callback(Canvas* canvas, void* context) {
    App* app = context;
    furi_mutex_acquire(app->mutex, FuriWaitForever);

    canvas_clear(canvas);

    // Header
    canvas_set_font(canvas, FontPrimary);
    canvas_draw_str(canvas, 2, 9, "Claude");
    canvas_set_font(canvas, FontSecondary);
    canvas_draw_str_aligned(
        canvas, 126, 9, AlignRight, AlignBottom, app->connected ? "BT" : "..");
    canvas_draw_line(canvas, 0, 11, 127, 11);

    if(app->count == 0) {
        canvas_set_font(canvas, FontSecondary);
        canvas_draw_str_aligned(
            canvas,
            64,
            38,
            AlignCenter,
            AlignCenter,
            app->connected ? "No active tasks" : "Waiting for daemon...");
    } else {
        for(uint8_t i = 0; i < app->count; i++) {
            TaskRow* r = &app->rows[i];
            int y = 12 + i * 13; // 4 rows of 13px fill the 52px below the header

            // Status glyph: filled box with the uppercase status letter.
            canvas_set_color(canvas, ColorBlack);
            canvas_draw_box(canvas, 2, y + 1, 11, 11);
            canvas_set_color(canvas, ColorWhite);
            char letter[2] = {status_letter(r->status), '\0'};
            canvas_set_font(canvas, FontPrimary);
            canvas_draw_str_aligned(canvas, 7, y + 7, AlignCenter, AlignCenter, letter);
            canvas_set_color(canvas, ColorBlack);

            // Name (bold) then message (regular), clipped at the screen edge.
            int tx = 16;
            int ty = y + 10;
            canvas_set_font(canvas, FontPrimary);
            canvas_draw_str(canvas, tx, ty, r->name);
            uint16_t nw = canvas_string_width(canvas, r->name);
            if(r->msg[0]) {
                canvas_set_font(canvas, FontSecondary);
                canvas_draw_str(canvas, tx + nw + 4, ty, r->msg);
            }
        }
    }

    furi_mutex_release(app->mutex);
}

static void input_callback(InputEvent* event, void* context) {
    App* app = context;
    furi_message_queue_put(app->input_queue, event, FuriWaitForever);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

static App* app_alloc(void) {
    App* app = malloc(sizeof(App));
    memset(app, 0, sizeof(App));

    app->mutex = furi_mutex_alloc(FuriMutexTypeNormal);
    app->input_queue = furi_message_queue_alloc(8, sizeof(InputEvent));

    app->view_port = view_port_alloc();
    view_port_draw_callback_set(app->view_port, draw_callback, app);
    view_port_input_callback_set(app->view_port, input_callback, app);

    app->gui = furi_record_open(RECORD_GUI);
    gui_add_view_port(app->gui, app->view_port, GuiLayerFullscreen);

    return app;
}

static void app_free(App* app) {
    gui_remove_view_port(app->gui, app->view_port);
    furi_record_close(RECORD_GUI);
    view_port_free(app->view_port);
    furi_message_queue_free(app->input_queue);
    furi_mutex_free(app->mutex);
    free(app);
}

static void bt_setup(App* app) {
    app->bt = furi_record_open(RECORD_BT);

    // Switch to the serial profile, using app-private bond storage so we don't
    // disturb the Flipper's default Bluetooth pairings.
    bt_disconnect(app->bt);
    furi_delay_ms(200); // let the 2nd core flush NVM
    bt_keys_storage_set_storage_path(app->bt, APP_DATA_PATH(KEYS_STORAGE_NAME));

    app->profile = bt_profile_start(app->bt, ble_profile_serial, NULL);
    furi_check(app->profile);

    furi_hal_bt_start_advertising();
    bt_set_status_changed_callback(app->bt, bt_status_callback, app);
    ble_profile_serial_set_event_callback(
        app->profile, sizeof(app->rx_accum), serial_event_callback, app);
}

static void bt_teardown(App* app) {
    bt_set_status_changed_callback(app->bt, NULL, NULL);
    bt_disconnect(app->bt);
    furi_delay_ms(200); // let the 2nd core flush NVM
    bt_keys_storage_set_default_path(app->bt);
    furi_check(bt_profile_restore_default(app->bt));
    furi_record_close(RECORD_BT);
    app->bt = NULL;
}

int32_t claude_status_app(void* p) {
    UNUSED(p);
    App* app = app_alloc();
    bt_setup(app);

    InputEvent event;
    bool running = true;
    while(running) {
        if(furi_message_queue_get(app->input_queue, &event, FuriWaitForever) == FuriStatusOk) {
            if(event.type == InputTypeShort && event.key == InputKeyBack) {
                running = false;
            }
        }
    }

    bt_teardown(app);
    app_free(app);
    return 0;
}
