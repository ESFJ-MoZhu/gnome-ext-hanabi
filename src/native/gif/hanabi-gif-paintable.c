#include "hanabi-gif-paintable.h"

#include <glycin-gtk4.h>

struct _HanabiGifPaintable
{
  GObject parent_instance;

  GFile *file;
  GBytes *bytes;
  GlyLoader *loader;
  GlyImage *image;
  GdkTexture *texture;
  GCancellable *cancellable;

  guint timeout_id;
  guint min_frame_delay_ms;
  guint initial_phase_ms;
  gboolean initial_phase_pending;
  GlySandboxSelector sandbox_selector;

  gboolean stopped;
  gboolean load_pending;
  gboolean frame_pending;
  guint generation;
  guint64 debug_id;

  int intrinsic_width;
  int intrinsic_height;

  guint64 frame_count;
  guint64 texture_count;
  guint64 released_frame_count;
  guint64 released_texture_count;
};

static guint64 next_paintable_debug_id = 0;

static void hanabi_gif_paintable_paintable_init(GdkPaintableInterface *iface);

G_DEFINE_TYPE_WITH_CODE(HanabiGifPaintable,
                        hanabi_gif_paintable,
                        G_TYPE_OBJECT,
                        G_IMPLEMENT_INTERFACE(GDK_TYPE_PAINTABLE,
                                              hanabi_gif_paintable_paintable_init))

static guint
hanabi_gif_paintable_delay_to_ms(HanabiGifPaintable *self,
                                 gint64 delay_us)
{
  guint delay_ms;

  if (delay_us <= 0)
    return 0;

  delay_ms = (guint)((delay_us + 999) / 1000);
  return MAX(delay_ms, self->min_frame_delay_ms);
}

static gboolean
hanabi_gif_paintable_error_is_cancelled(GError *error)
{
  return error != NULL && g_error_matches(error, G_IO_ERROR, G_IO_ERROR_CANCELLED);
}

static gboolean
hanabi_gif_paintable_is_current(HanabiGifPaintable *self,
                                guint generation)
{
  return generation == self->generation &&
         !self->stopped &&
         self->cancellable != NULL &&
         !g_cancellable_is_cancelled(self->cancellable);
}

static void
hanabi_gif_paintable_clear_current_texture(HanabiGifPaintable *self)
{
  if (self->texture != NULL)
    {
      g_clear_object(&self->texture);
      self->released_texture_count++;
    }
}

static void
hanabi_gif_paintable_schedule_next_frame(HanabiGifPaintable *self,
                                         guint delay_ms,
                                         guint generation);

static void
hanabi_gif_paintable_request_frame(HanabiGifPaintable *self,
                                   guint generation);

static gboolean
hanabi_gif_paintable_frame_timeout_cb(gpointer user_data)
{
  HanabiGifPaintable *self = HANABI_GIF_PAINTABLE(user_data);
  guint generation = self->generation;

  self->timeout_id = 0;

  if (hanabi_gif_paintable_is_current(self, generation))
    hanabi_gif_paintable_request_frame(self, generation);

  return G_SOURCE_REMOVE;
}

static void
hanabi_gif_paintable_schedule_next_frame(HanabiGifPaintable *self,
                                         guint delay_ms,
                                         guint generation)
{
  guint scheduled_delay_ms;

  if (delay_ms == 0 || !hanabi_gif_paintable_is_current(self, generation))
    return;

  scheduled_delay_ms = delay_ms;
  if (self->initial_phase_pending)
    {
      scheduled_delay_ms += self->initial_phase_ms;
      self->initial_phase_pending = FALSE;
    }

  self->timeout_id = g_timeout_add_full(G_PRIORITY_DEFAULT,
                                        scheduled_delay_ms,
                                        hanabi_gif_paintable_frame_timeout_cb,
                                        g_object_ref(self),
                                        g_object_unref);
}

static void
hanabi_gif_paintable_present_frame(HanabiGifPaintable *self,
                                   GlyFrame *new_frame,
                                   guint generation)
{
  GdkTexture *new_texture;
  guint frame_width;
  guint frame_height;
  gboolean size_changed = FALSE;
  gint64 delay_us;
  guint delay_ms;

  if (!hanabi_gif_paintable_is_current(self, generation))
    {
      g_object_unref(new_frame);
      return;
    }

  frame_width = gly_frame_get_width(new_frame);
  frame_height = gly_frame_get_height(new_frame);
  delay_us = gly_frame_get_delay(new_frame);
  delay_ms = hanabi_gif_paintable_delay_to_ms(self, delay_us);

  if (self->intrinsic_width != (int)frame_width ||
      self->intrinsic_height != (int)frame_height)
    {
      self->intrinsic_width = (int)frame_width;
      self->intrinsic_height = (int)frame_height;
      size_changed = TRUE;
    }

  /*
   * GJS can hold transfer-full GlyFrame/GdkTexture wrappers until a later GC
   * pass, which is exactly the wrong ownership model for dozens of always-on
   * GIF previews. This paintable keeps the steady-state native lifetime to one
   * visible texture: the old texture is released before the replacement is
   * installed, and the decoded frame is unreffed immediately after Glycin has
   * produced the texture that GTK snapshots. The counters stay exposed for
   * targeted diagnostics when frame and texture ownership needs to be audited.
   */
  hanabi_gif_paintable_clear_current_texture(self);
  new_texture = gly_gtk_frame_get_texture(new_frame);
  self->frame_count++;
  g_object_unref(new_frame);
  self->released_frame_count++;

  if (new_texture == NULL)
    {
      g_warning("hanabi-gif: failed to create texture from frame");
      return;
    }

  self->texture = new_texture;
  self->texture_count++;

  if (size_changed)
    gdk_paintable_invalidate_size(GDK_PAINTABLE(self));
  gdk_paintable_invalidate_contents(GDK_PAINTABLE(self));

  hanabi_gif_paintable_schedule_next_frame(self, delay_ms, generation);
}

static void
hanabi_gif_paintable_next_frame_cb(GObject *source_object,
                                   GAsyncResult *result,
                                   gpointer user_data)
{
  HanabiGifPaintable *self = HANABI_GIF_PAINTABLE(user_data);
  GlyImage *image = GLY_IMAGE(source_object);
  GlyFrame *new_frame = NULL;
  GError *error = NULL;
  guint generation = self->generation;

  self->frame_pending = FALSE;

  /*
   * Always finish the Glycin async operation, even after stop() has cancelled
   * the shared GCancellable and advanced the generation.  Skipping _finish()
   * leaves the loader side with an uncollected async result, which can keep the
   * glycin-image-rs sandbox alive after the GTK widget that requested the frame
   * has already been removed from the preferences dialog.
   */
  new_frame = gly_image_next_frame_finish(image, result, &error);
  if (new_frame == NULL)
    {
      if (hanabi_gif_paintable_error_is_cancelled(error))
        g_message("hanabi-gif[%" G_GUINT64_FORMAT "]: frame request cancelled generation=%u",
                  self->debug_id,
                  generation);
      if (!hanabi_gif_paintable_error_is_cancelled(error))
        g_warning("hanabi-gif[%" G_GUINT64_FORMAT "]: frame load failed: %s",
                  self->debug_id,
                  error ? error->message : "unknown error");
      g_clear_error(&error);
      goto out;
    }

  if (!hanabi_gif_paintable_is_current(self, generation))
    {
      g_message("hanabi-gif[%" G_GUINT64_FORMAT "]: releasing stale frame generation=%u current-generation=%u",
                self->debug_id,
                generation,
                self->generation);
      g_object_unref(new_frame);
      self->released_frame_count++;
      goto out;
    }

  hanabi_gif_paintable_present_frame(self, new_frame, generation);

out:
  g_object_unref(self);
}

static void
hanabi_gif_paintable_request_frame(HanabiGifPaintable *self,
                                   guint generation)
{
  if (!hanabi_gif_paintable_is_current(self, generation) ||
      self->image == NULL ||
      self->frame_pending)
    return;

  self->frame_pending = TRUE;
  g_object_ref(self);
  gly_image_next_frame_async(self->image,
                             self->cancellable,
                             hanabi_gif_paintable_next_frame_cb,
                             self);
}

static void
hanabi_gif_paintable_load_cb(GObject *source_object,
                             GAsyncResult *result,
                             gpointer user_data)
{
  HanabiGifPaintable *self = HANABI_GIF_PAINTABLE(user_data);
  GlyLoader *loader = GLY_LOADER(source_object);
  GlyImage *loaded_image = NULL;
  GError *error = NULL;
  guint generation = self->generation;

  self->load_pending = FALSE;

  /*
   * Match the frame callback: cancellation makes this paintable stale, but the
   * async load result still belongs to Glycin and must be completed with
   * gly_loader_load_finish() so the sandbox process can release its side of the
   * request promptly.
   */
  loaded_image = gly_loader_load_finish(loader, result, &error);
  if (loaded_image == NULL)
    {
      if (hanabi_gif_paintable_error_is_cancelled(error))
        g_message("hanabi-gif[%" G_GUINT64_FORMAT "]: load request cancelled generation=%u",
                  self->debug_id,
                  generation);
      if (!hanabi_gif_paintable_error_is_cancelled(error))
        g_warning("hanabi-gif[%" G_GUINT64_FORMAT "]: load failed: %s",
                  self->debug_id,
                  error ? error->message : "unknown error");
      g_clear_error(&error);
      goto out;
    }

  if (!hanabi_gif_paintable_is_current(self, generation))
    {
      g_message("hanabi-gif[%" G_GUINT64_FORMAT "]: releasing stale loaded image generation=%u current-generation=%u",
                self->debug_id,
                generation,
                self->generation);
      g_object_unref(loaded_image);
      goto out;
    }

  self->image = loaded_image;
  hanabi_gif_paintable_request_frame(self, generation);

out:
  g_object_unref(self);
}

static void
hanabi_gif_paintable_start(HanabiGifPaintable *self)
{
  g_return_if_fail(HANABI_IS_GIF_PAINTABLE(self));
  g_return_if_fail(G_IS_FILE(self->file) || self->bytes != NULL);

  self->stopped = FALSE;
  self->generation++;
  self->cancellable = g_cancellable_new();
  self->loader = self->file != NULL
                     ? gly_loader_new(self->file)
                     : gly_loader_new_for_bytes(self->bytes);

  gly_loader_set_sandbox_selector(self->loader, self->sandbox_selector);
  gly_loader_set_apply_transformations(self->loader, TRUE);
  gly_loader_set_accepted_memory_formats(
      self->loader,
      GLY_MEMORY_SELECTION_B8G8R8A8_PREMULTIPLIED |
          GLY_MEMORY_SELECTION_R8G8B8A8_PREMULTIPLIED |
          GLY_MEMORY_SELECTION_B8G8R8A8 |
          GLY_MEMORY_SELECTION_R8G8B8A8 |
          GLY_MEMORY_SELECTION_R8G8B8 |
          GLY_MEMORY_SELECTION_B8G8R8);

  self->load_pending = TRUE;
  g_message("hanabi-gif[%" G_GUINT64_FORMAT "]: start generation=%u source=%s",
            self->debug_id,
            self->generation,
            self->file != NULL ? "file" : "bytes");
  g_object_ref(self);
  gly_loader_load_async(self->loader,
                        self->cancellable,
                        hanabi_gif_paintable_load_cb,
                        self);
}

static void
hanabi_gif_paintable_snapshot(GdkPaintable *paintable,
                              GdkSnapshot *snapshot,
                              double width,
                              double height)
{
  HanabiGifPaintable *self = HANABI_GIF_PAINTABLE(paintable);
  graphene_rect_t bounds;

  if (self->texture == NULL)
    return;

  graphene_rect_init(&bounds, 0.0f, 0.0f, (float)width, (float)height);
  gtk_snapshot_append_texture(GTK_SNAPSHOT(snapshot), self->texture, &bounds);
}

static GdkPaintableFlags
hanabi_gif_paintable_get_flags(GdkPaintable *paintable)
{
  (void)paintable;
  return 0;
}

static int
hanabi_gif_paintable_get_intrinsic_width(GdkPaintable *paintable)
{
  HanabiGifPaintable *self = HANABI_GIF_PAINTABLE(paintable);
  return self->intrinsic_width;
}

static int
hanabi_gif_paintable_get_intrinsic_height(GdkPaintable *paintable)
{
  HanabiGifPaintable *self = HANABI_GIF_PAINTABLE(paintable);
  return self->intrinsic_height;
}

static double
hanabi_gif_paintable_get_intrinsic_aspect_ratio(GdkPaintable *paintable)
{
  HanabiGifPaintable *self = HANABI_GIF_PAINTABLE(paintable);

  if (self->intrinsic_width <= 0 || self->intrinsic_height <= 0)
    return 0.0;

  return (double)self->intrinsic_width / (double)self->intrinsic_height;
}

static void
hanabi_gif_paintable_paintable_init(GdkPaintableInterface *iface)
{
  iface->snapshot = hanabi_gif_paintable_snapshot;
  iface->get_flags = hanabi_gif_paintable_get_flags;
  iface->get_intrinsic_width = hanabi_gif_paintable_get_intrinsic_width;
  iface->get_intrinsic_height = hanabi_gif_paintable_get_intrinsic_height;
  iface->get_intrinsic_aspect_ratio = hanabi_gif_paintable_get_intrinsic_aspect_ratio;
}

static void
hanabi_gif_paintable_dispose(GObject *object)
{
  HanabiGifPaintable *self = HANABI_GIF_PAINTABLE(object);

  hanabi_gif_paintable_stop(self);
  g_clear_object(&self->file);
  g_clear_pointer(&self->bytes, g_bytes_unref);

  G_OBJECT_CLASS(hanabi_gif_paintable_parent_class)->dispose(object);
}

static void
hanabi_gif_paintable_class_init(HanabiGifPaintableClass *klass)
{
  GObjectClass *object_class = G_OBJECT_CLASS(klass);

  object_class->dispose = hanabi_gif_paintable_dispose;
}

static void
hanabi_gif_paintable_init(HanabiGifPaintable *self)
{
  self->min_frame_delay_ms = 20;
  self->sandbox_selector = GLY_SANDBOX_SELECTOR_AUTO;
  self->initial_phase_pending = TRUE;
  self->stopped = TRUE;
  self->debug_id = ++next_paintable_debug_id;
}

/**
 * hanabi_gif_paintable_new:
 * @file: GIF file to play.
 * @min_frame_delay_ms: Lower bound for animation pacing in milliseconds.
 * @initial_phase_ms: One-shot extra delay after the first frame.
 * @sandbox_selector: Glycin sandbox mode.
 *
 * Returns: (transfer full): a new GIF paintable.
 */
HanabiGifPaintable *
hanabi_gif_paintable_new(GFile *file,
                         guint min_frame_delay_ms,
                         guint initial_phase_ms,
                         GlySandboxSelector sandbox_selector)
{
  HanabiGifPaintable *self;

  g_return_val_if_fail(G_IS_FILE(file), NULL);

  self = g_object_new(HANABI_TYPE_GIF_PAINTABLE, NULL);
  self->file = g_object_ref(file);
  self->min_frame_delay_ms = MAX(min_frame_delay_ms, 1);
  self->initial_phase_ms = initial_phase_ms;
  self->initial_phase_pending = initial_phase_ms > 0;
  self->sandbox_selector = sandbox_selector;

  hanabi_gif_paintable_start(self);

  return self;
}

/**
 * hanabi_gif_paintable_new_for_bytes:
 * @bytes: GIF bytes to play.
 * @min_frame_delay_ms: Lower bound for animation pacing in milliseconds.
 * @initial_phase_ms: One-shot extra delay after the first frame.
 * @sandbox_selector: Glycin sandbox mode.
 *
 * Returns: (transfer full): a new GIF paintable.
 */
HanabiGifPaintable *
hanabi_gif_paintable_new_for_bytes(GBytes *bytes,
                                   guint min_frame_delay_ms,
                                   guint initial_phase_ms,
                                   GlySandboxSelector sandbox_selector)
{
  HanabiGifPaintable *self;

  g_return_val_if_fail(bytes != NULL, NULL);

  self = g_object_new(HANABI_TYPE_GIF_PAINTABLE, NULL);
  self->bytes = g_bytes_ref(bytes);
  self->min_frame_delay_ms = MAX(min_frame_delay_ms, 1);
  self->initial_phase_ms = initial_phase_ms;
  self->initial_phase_pending = initial_phase_ms > 0;
  self->sandbox_selector = sandbox_selector;

  hanabi_gif_paintable_start(self);

  return self;
}

void
hanabi_gif_paintable_stop(HanabiGifPaintable *self)
{
  g_return_if_fail(HANABI_IS_GIF_PAINTABLE(self));

  g_message("hanabi-gif[%" G_GUINT64_FORMAT "]: stop generation=%u load-pending=%s frame-pending=%s frames=%" G_GUINT64_FORMAT " textures=%" G_GUINT64_FORMAT " released-frames=%" G_GUINT64_FORMAT " released-textures=%" G_GUINT64_FORMAT,
            self->debug_id,
            self->generation,
            self->load_pending ? "true" : "false",
            self->frame_pending ? "true" : "false",
            self->frame_count,
            self->texture_count,
            self->released_frame_count,
            self->released_texture_count);

  self->stopped = TRUE;
  self->generation++;

  if (self->timeout_id != 0)
    {
      g_source_remove(self->timeout_id);
      self->timeout_id = 0;
    }

  if (self->cancellable != NULL)
    g_cancellable_cancel(self->cancellable);

  self->load_pending = FALSE;
  self->frame_pending = FALSE;

  hanabi_gif_paintable_clear_current_texture(self);
  g_clear_object(&self->image);
  g_clear_object(&self->loader);
  g_clear_object(&self->cancellable);

  gdk_paintable_invalidate_contents(GDK_PAINTABLE(self));
}

guint64
hanabi_gif_paintable_get_frame_count(HanabiGifPaintable *self)
{
  g_return_val_if_fail(HANABI_IS_GIF_PAINTABLE(self), 0);
  return self->frame_count;
}

guint64
hanabi_gif_paintable_get_texture_count(HanabiGifPaintable *self)
{
  g_return_val_if_fail(HANABI_IS_GIF_PAINTABLE(self), 0);
  return self->texture_count;
}

guint64
hanabi_gif_paintable_get_released_frame_count(HanabiGifPaintable *self)
{
  g_return_val_if_fail(HANABI_IS_GIF_PAINTABLE(self), 0);
  return self->released_frame_count;
}

guint64
hanabi_gif_paintable_get_released_texture_count(HanabiGifPaintable *self)
{
  g_return_val_if_fail(HANABI_IS_GIF_PAINTABLE(self), 0);
  return self->released_texture_count;
}
