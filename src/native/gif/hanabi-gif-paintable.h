#pragma once

#include <gio/gio.h>
#include <glycin.h>
#include <gtk/gtk.h>

G_BEGIN_DECLS

#define HANABI_TYPE_GIF_PAINTABLE (hanabi_gif_paintable_get_type())

G_DECLARE_FINAL_TYPE(HanabiGifPaintable, hanabi_gif_paintable, HANABI, GIF_PAINTABLE, GObject)

HanabiGifPaintable *hanabi_gif_paintable_new(GFile *file,
                                             guint min_frame_delay_ms,
                                             guint initial_phase_ms,
                                             GlySandboxSelector sandbox_selector);

HanabiGifPaintable *hanabi_gif_paintable_new_for_bytes(GBytes *bytes,
                                                       guint min_frame_delay_ms,
                                                       guint initial_phase_ms,
                                                       GlySandboxSelector sandbox_selector);

void hanabi_gif_paintable_stop(HanabiGifPaintable *self);

guint64 hanabi_gif_paintable_get_frame_count(HanabiGifPaintable *self);
guint64 hanabi_gif_paintable_get_texture_count(HanabiGifPaintable *self);
guint64 hanabi_gif_paintable_get_released_frame_count(HanabiGifPaintable *self);
guint64 hanabi_gif_paintable_get_released_texture_count(HanabiGifPaintable *self);

G_END_DECLS
