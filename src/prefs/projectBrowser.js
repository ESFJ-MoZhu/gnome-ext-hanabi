import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GIRepository from 'gi://GIRepository';
import Graphene from 'gi://Graphene?version=1.0';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';
import Soup from 'gi://Soup?version=3.0';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import * as BuildConfig from '../buildConfig.js';

const giRepository = GIRepository.Repository.dup_default();

function prependRepositoryDir(path, prependFn) {
    if (!path || !GLib.file_test(path, GLib.FileTest.IS_DIR))
        return false;

    prependFn.call(giRepository, path);
    return true;
}

prependRepositoryDir(BuildConfig.nativeSceneTypelibDir, giRepository.prepend_search_path);
prependRepositoryDir(BuildConfig.nativeSceneLibDir, giRepository.prepend_library_path);

let HanabiGif = null;
try {
    HanabiGif = (await import('gi://HanabiGif?version=1.0')).default;
} catch (error) {
    console.warn(`Hanabi preferences: native GIF preview playback is disabled because HanabiGif is unavailable: ${error}`);
}

import {
    ProjectBrowserFilterKey,
    ProjectContentRatings,
    ProjectType,
    ScenePropertyType,
    UserPropertyStoreKey,
    areScenePropertyValuesEqual,
    buildScenePropertyValueMap,
    getProjectFilterTagOptions,
    getProjectFilterFromSettings,
    getProjectScenePropertyOverrides,
    getProjectWebPropertyOverrides,
    isScenePropertyVisible,
    listProjects,
    loadProject,
    normalizeLibraryRootPath,
    normalizeScenePropertyValue,
    projectMatchesFilter,
    serializeStoredScenePropertyOverrides,
    setProjectFilterInSettings,
    setProjectScenePropertyOverrides,
    setProjectWebPropertyOverrides
} from '../project.js';
import {connectTracked} from './rows.js';

const GpuPipelinePolicy = imports.gpuPipelinePolicy;

// Resolve paths from this module so the preview actions work both from the
// installed extension directory and from an in-tree development build where the
// preferences module still sits next to the renderer directory under src/.
const moduleDir = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const extensionDir = GLib.path_get_dirname(moduleDir);
const rendererScriptPath = GLib.build_filenamev([extensionDir, 'renderer', 'renderer.js']);

// Match the native GIF stress-test grid: square previews fill the available
// width with no gutter, only adding a new column when the current physical tile
// size would exceed this range on the active monitor scale.
const PROJECT_PREVIEW_INITIAL_COLUMNS = 8;
const PROJECT_PREVIEW_MIN_TILE_SIZE = 256;
const PROJECT_PREVIEW_MAX_TILE_SIZE = 384;
const PROJECT_PREVIEW_STATIC_TEXTURE_SIZE = PROJECT_PREVIEW_MAX_TILE_SIZE;
const PROJECT_PREVIEW_MIN_FRAME_DELAY_MS = 20;
const PROJECT_PREVIEW_START_STAGGER_MS = 25;
const PROJECT_PREVIEW_MAX_FRAME_PHASE_MS = 48;
const GLY_SANDBOX_SELECTOR_AUTO = 0;
// GTK reports mouse buttons as numeric event values; naming the two buttons we
// care about keeps card activation and thumbnail context-menu handling from
// accidentally sharing the same all-buttons gesture.
const PROJECT_CARD_PRIMARY_BUTTON = 1;
const PROJECT_CARD_SECONDARY_BUTTON = 3;
// Thumbnail work is deliberately capped so opening Browse only creates cheap
// placeholder widgets on the main thread, while disk reads and pixbuf decoding
// are allowed to complete in a small background stream instead of stampeding.
const PROJECT_THUMBNAIL_CONCURRENCY = 3;
// Treat 1600x900 as the scale-1 physical preview target, then convert it to
// GTK logical window units for the monitor where the preferences thumbnail
// lives. On scale 2 this intentionally becomes 800x450.
const PROJECT_PREVIEW_WINDOW_BASE_WIDTH = 1600;
const PROJECT_PREVIEW_WINDOW_BASE_HEIGHT = 900;
const PROJECT_BROWSER_DIALOG_DEFAULT_WIDTH = 1280;
const PROJECT_BROWSER_DIALOG_DEFAULT_HEIGHT = 900;
const SCENE_PROPERTY_PANEL_WIDTH = 360;
// Rich scene metadata can embed remote Workshop images in text-only properties
// such as "About me". Keep those downloaded bytes in the same durable scene
// cache root that the native renderer already uses, so reopening preferences
// does not depend on repeated internet requests for unchanged project metadata.
const SCENE_IMAGE_CACHE_DIR = GLib.build_filenamev([GLib.get_user_cache_dir(), 'hanabi-scene']);
const SCENE_IMAGE_CACHE_FILE_PREFIX = 'prefs-image-';
const INSPECTOR_ROW_HORIZONTAL_MARGIN = 24;
const INSPECTOR_ROW_CONTROL_SPACING = 12;
const INSPECTOR_WIDE_CONTROL_WIDTH = 180;
const INSPECTOR_NARROW_CONTROL_WIDTH = 56;
const PROJECT_BROWSER_SORT_KEYS = {
    NAME: 'name',
    FILE_SIZE: 'file-size',
    UPDATED_TIME: 'updated-time',
};
const PROJECT_BROWSER_SORT_SETTINGS_KEY = 'project-browser-sort-key';

function compareProjectTitles(left, right) {
    const leftTitle = `${left?.title || left?.basename || left?.path || ''}`.toLowerCase();
    const rightTitle = `${right?.title || right?.basename || right?.path || ''}`.toLowerCase();
    return leftTitle.localeCompare(rightTitle) || `${left?.path ?? ''}`.localeCompare(`${right?.path ?? ''}`);
}

function compareNumbersDescending(left, right) {
    // GTK only needs the sign of a sort result; normalizing the comparison
    // keeps very large directory sizes or microsecond timestamps from relying
    // on callback marshalling of oversized numeric differences.
    if (left === right)
        return 0;
    return left > right ? -1 : 1;
}

function getFileInfoModifiedTimeUs(info) {
    return (
        info.get_attribute_uint64('time::modified') * GLib.USEC_PER_SEC +
        info.get_attribute_uint32('time::modified-usec')
    );
}

function queryFileModifiedTimeUs(file) {
    try {
        const info = file.query_info(
            'time::modified,time::modified-usec',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
            null
        );

        return getFileInfoModifiedTimeUs(info);
    } catch (_error) {
        return 0;
    }
}

function queryProjectLastUpdatedTime(project) {
    return project?.path ? queryFileModifiedTimeUs(Gio.File.new_for_path(project.path)) : 0;
}

function queryProjectDirectorySize(path) {
    let totalSize = 0;

    try {
        const dir = Gio.File.new_for_path(path);
        const enumerator = dir.enumerate_children(
            'standard::name,standard::type,standard::size',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
            null
        );

        let info;
        while ((info = enumerator.next_file(null))) {
            const child = dir.get_child(info.get_name());
            if (info.get_file_type() === Gio.FileType.DIRECTORY) {
                totalSize += queryProjectDirectorySize(child.get_path());
                continue;
            }

            // Sorting by "file size" means the whole wallpaper project payload,
            // not only project.json or the launch entry, so every regular child
            // file contributes to the cached total.
            if (info.get_file_type() === Gio.FileType.REGULAR)
                totalSize += info.get_size();
        }

        enumerator.close(null);
    } catch (_error) {
        return totalSize;
    }

    return totalSize;
}

function sandboxSelectorFromDefault() {
    return GLY_SANDBOX_SELECTOR_AUTO;
}

function imageSourceLooksGif(source) {
    if (typeof source !== 'string')
        return false;

    return source.trim().toLowerCase().split(/[?#]/, 1)[0].endsWith('.gif');
}

function bytesLookLikeGif(bytes) {
    const data = bytes?.get_data?.();
    return data instanceof Uint8Array &&
        data.length >= 6 &&
        data[0] === 0x47 &&
        data[1] === 0x49 &&
        data[2] === 0x46 &&
        data[3] === 0x38 &&
        (data[4] === 0x37 || data[4] === 0x39) &&
        data[5] === 0x61;
}

function createNativeGifPaintableForFile(file, initialPhaseMs = 0) {
    if (!HanabiGif?.GifPaintable)
        return null;

    return HanabiGif.GifPaintable.new(
        file,
        PROJECT_PREVIEW_MIN_FRAME_DELAY_MS,
        initialPhaseMs,
        sandboxSelectorFromDefault()
    );
}

function createNativeGifPaintableForBytes(bytes, initialPhaseMs = 0) {
    if (!HanabiGif?.GifPaintable?.new_for_bytes)
        return null;

    return HanabiGif.GifPaintable.new_for_bytes(
        bytes,
        PROJECT_PREVIEW_MIN_FRAME_DELAY_MS,
        initialPhaseMs,
        sandboxSelectorFromDefault()
    );
}

function projectPreviewIsGif(path) {
    return imageSourceLooksGif(path);
}

function normalizeProjectBrowserSortKey(key) {
    return Object.values(PROJECT_BROWSER_SORT_KEYS).includes(key)
        ? key
        : PROJECT_BROWSER_SORT_KEYS.NAME;
}

function formatProjectTypeLabel(type) {
    switch (type) {
    case ProjectType.SCENE:
        return _('Scene');
    case ProjectType.WEB:
        return _('Web');
    case ProjectType.VIDEO:
        return _('Video');
    default:
        return type || _('Unknown');
    }
}

function formatProjectContentRatingLabel(rating) {
    switch (rating) {
    case 'Everyone':
        return _('Everyone');
    case 'Questionable':
        return _('Questionable');
    case 'Mature':
        return _('Mature');
    default:
        return rating;
    }
}

function formatProjectGenreLabel(tag) {
    switch (tag) {
    case 'Abstract':
        return _('Abstract');
    case 'Animal':
        return _('Animal');
    case 'Anime':
        return _('Anime');
    case 'Cartoon':
        return _('Cartoon');
    case 'CGI':
        return _('CGI');
    case 'Cyberpunk':
        return _('Cyberpunk');
    case 'Fantasy':
        return _('Fantasy');
    case 'Game':
        return _('Game');
    case 'Girls':
        return _('Girls');
    case 'Guys':
        return _('Guys');
    case 'Landscape':
        return _('Landscape');
    case 'Medieval':
        return _('Medieval');
    case 'Memes':
        return _('Memes');
    case 'MMD':
        return _('MMD');
    case 'Music':
        return _('Music');
    case 'Nature':
        return _('Nature');
    case 'Pixel art':
        return _('Pixel art');
    case 'Relaxing':
        return _('Relaxing');
    case 'Retro':
        return _('Retro');
    case 'Sci-Fi':
        return _('Sci-Fi');
    case 'Sports':
        return _('Sports');
    case 'Technology':
        return _('Technology');
    case 'Television':
        return _('Television');
    case 'Vehicle':
        return _('Vehicle');
    case 'Unspecified':
        return _('Unspecified');
    default:
        return tag;
    }
}

export function formatProjectSubtitle(path) {
    if (!path)
        return _('None');

    const project = loadProject(path);
    if (!project)
        return path;

    const title = typeof project.title === 'string' && project.title !== ''
        ? project.title
        : project.basename || path;
    return `${title} (${formatProjectTypeLabel(project.type)})`;
}

export function formatLibrarySubtitle(path) {
    return normalizeLibraryRootPath(path) || _('None');
}

export function prefsRowLibraryPath(window, prefsGroup) {
    const settings = window._settings;
    const title = _('Steam Library');
    const key = 'change-wallpaper-directory-path';

    let path = settings.get_string(key);
    const row = new Adw.ActionRow({
        title,
        subtitle: formatLibrarySubtitle(path),
    });
    prefsGroup.add(row);

    function createDialog() {
        let fileChooser = new Gtk.FileChooserDialog({
            title: _('Select Steam Library'),
            action: Gtk.FileChooserAction.SELECT_FOLDER,
        });
        fileChooser.set_modal(true);
        fileChooser.set_transient_for(window);
        fileChooser.add_button(_('Cancel'), Gtk.ResponseType.CANCEL);
        fileChooser.add_button(_('Open'), Gtk.ResponseType.ACCEPT);

        fileChooser.connect('response', (dialog, responseId) => {
            if (responseId === Gtk.ResponseType.ACCEPT) {
                let _path = normalizeLibraryRootPath(dialog.get_file().get_path());
                settings.set_string(key, _path);
                row.subtitle = formatLibrarySubtitle(_path);
            }
            dialog.destroy();
        });
        return fileChooser;
    }

    let button = new Adw.ButtonContent({
        icon_name: 'document-open-symbolic',
        label: _('Open'),
    });

    row.activatable_widget = button;
    row.add_suffix(button);

    row.connect('activated', () => {
        let dialog = createDialog();
        dialog.show();
    });

    connectTracked(window, settings, `changed::${key}`, () => {
        const nextPath = settings.get_string(key);
        const normalized = normalizeLibraryRootPath(nextPath);
        if (normalized !== nextPath) {
            settings.set_string(key, normalized);
            return;
        }
        row.subtitle = formatLibrarySubtitle(normalized);
    });
}

function buildProjectSearchText(project) {
    return [
        project.title,
        project.basename,
        project.type,
        project.description,
        ...project.tags ?? [],
    ].join(' ').toLowerCase();
}

function getUserPropertyStoreFromSettings(settings) {
    // The preferences UI reads the same neutral key that the renderer watches,
    // keeping web and scene overrides synchronized without any backend-specific
    // compatibility store or migration branch.
    return settings.get_string(UserPropertyStoreKey);
}

function getProjectPropertyOverrides(settings, project) {
    const userPropertyStore = getUserPropertyStoreFromSettings(settings);
    if (project?.type === 'web')
        return getProjectWebPropertyOverrides(userPropertyStore, project);
    return getProjectScenePropertyOverrides(userPropertyStore, project);
}

function setProjectPropertyOverrides(settings, project, overrides) {
    const userPropertyStore = getUserPropertyStoreFromSettings(settings);
    const nextStore = project?.type === 'web'
        ? setProjectWebPropertyOverrides(userPropertyStore, project, overrides)
        : setProjectScenePropertyOverrides(userPropertyStore, project, overrides);

    // Persist the complete shared JSON store after backend-specific value
    // normalization so both web and scene project payloads resolve from one key.
    settings.set_string(
        UserPropertyStoreKey,
        serializeStoredScenePropertyOverrides(nextStore)
    );
    return getProjectPropertyOverrides(settings, project);
}

function isPreviewLoadCancelled(error) {
    // GIO reports user-driven dialog teardown and per-widget destruction as a
    // normal cancellation error; filtering it keeps diagnostics focused on real
    // decode or filesystem failures that still need investigation.
    return error?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED) ?? false;
}

/**
 * Check whether a Gio async failure is a regular cache miss.
 *
 * @param {Error} error Error raised by Gio.
 * @returns {boolean} True when the error represents a missing file.
 */
function isFileNotFoundError(error) {
    return error?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND) ?? false;
}

/**
 * Build the on-disk cache file for a remote scene metadata image.
 *
 * @param {string} uri Original remote image URI.
 * @returns {Gio.File} Deterministic cache file for the URI.
 */
function createSceneImageCacheFile(uri) {
    const hash = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, uri, -1);
    return Gio.File.new_for_path(GLib.build_filenamev([
        SCENE_IMAGE_CACHE_DIR,
        `${SCENE_IMAGE_CACHE_FILE_PREFIX}${hash}`,
    ]));
}

/**
 * Ensure the durable scene image cache directory exists.
 *
 * @returns {boolean} True when the cache directory can be used.
 */
function ensureSceneImageCacheDirectory() {
    if (GLib.mkdir_with_parents(SCENE_IMAGE_CACHE_DIR, 0o755) === 0)
        return true;

    console.warn(`Hanabi preferences: failed to create scene image cache directory "${SCENE_IMAGE_CACHE_DIR}"`);
    return false;
}

/**
 * Read an entire file as GLib.Bytes without blocking GTK layout.
 *
 * @param {Gio.File} file File to read.
 * @param {Gio.Cancellable} cancellable Request cancellation token.
 * @returns {Promise<GLib.Bytes>} File payload.
 */
function loadBytesFromFileAsync(file, cancellable) {
    return new Promise((resolve, reject) => {
        file.load_bytes_async(cancellable, (source, result) => {
            try {
                const [bytes] = source.load_bytes_finish(result);
                resolve(bytes);
            } catch (e) {
                reject(e);
            }
        });
    });
}

/**
 * Atomically replace a cache file with downloaded bytes.
 *
 * @param {Gio.File} file File to replace.
 * @param {GLib.Bytes} bytes Payload to write.
 * @param {Gio.Cancellable} cancellable Request cancellation token.
 * @returns {Promise<void>} Resolves when the write has completed.
 */
function replaceFileBytesAsync(file, bytes, cancellable) {
    return new Promise((resolve, reject) => {
        file.replace_contents_bytes_async(
            bytes,
            null,
            false,
            Gio.FileCreateFlags.REPLACE_DESTINATION,
            cancellable,
            (source, result) => {
                try {
                    source.replace_contents_finish(result);
                    resolve();
                } catch (e) {
                    reject(e);
                }
            }
        );
    });
}

/**
 * Download a remote scene metadata image and fail on non-success HTTP statuses.
 *
 * @param {Soup.Session} session Shared Soup session for the preferences dialog.
 * @param {string} uri Remote image URI.
 * @param {Gio.Cancellable} cancellable Request cancellation token.
 * @returns {Promise<GLib.Bytes>} Downloaded image payload.
 */
function downloadSceneImageBytesAsync(session, uri, cancellable) {
    return new Promise((resolve, reject) => {
        const message = Soup.Message.new('GET', uri);
        session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable, (source, result) => {
            try {
                const bytes = source.send_and_read_finish(result);
                if (message.status_code < 200 || message.status_code >= 300)
                    throw new Error(`HTTP ${message.status_code}`);

                resolve(bytes);
            } catch (e) {
                reject(e);
            }
        });
    });
}

/**
 * Load remote scene metadata image bytes from ~/.cache/hanabi-scene when present.
 *
 * @param {Soup.Session} session Shared Soup session for cache misses.
 * @param {string} uri Remote image URI.
 * @param {Gio.Cancellable} cancellable Request cancellation token.
 * @returns {Promise<GLib.Bytes>} Cached or freshly downloaded image payload.
 */
async function loadCachedRemoteSceneImageBytesAsync(session, uri, cancellable) {
    const cacheFile = createSceneImageCacheFile(uri);
    try {
        return await loadBytesFromFileAsync(cacheFile, cancellable);
    } catch (error) {
        if (isPreviewLoadCancelled(error))
            throw error;

        if (!isFileNotFoundError(error)) {
            console.warn(
                `Hanabi preferences: failed to read cached scene image "${cacheFile.get_path()}"; ` +
                `redownloading "${uri}": ${error}`
            );
        }
    }

    /*
     * The cache is URL-addressed and intentionally content-agnostic: GTK and the
     * native GIF paintable both sniff the downloaded bytes, so preserving file
     * extensions or server content types would only add metadata we do not need
     * to render the inspector. Failed cache writes are logged but non-fatal; a
     * freshly downloaded image should still appear even when the cache directory
     * is temporarily unavailable.
     */
    const bytes = await downloadSceneImageBytesAsync(session, uri, cancellable);
    if (cancellable.is_cancelled())
        return bytes;

    if (ensureSceneImageCacheDirectory()) {
        try {
            await replaceFileBytesAsync(cacheFile, bytes, cancellable);
        } catch (error) {
            if (!isPreviewLoadCancelled(error)) {
                console.warn(
                    `Hanabi preferences: failed to write cached scene image "${cacheFile.get_path()}" ` +
                    `for "${uri}": ${error}`
                );
            }
        }
    }

    return bytes;
}

function readProjectPreviewStreamAsync(path, cancellable) {
    const file = Gio.File.new_for_path(path);
    return new Promise((resolve, reject) => {
        file.read_async(GLib.PRIORITY_LOW, cancellable, (source, result) => {
            try {
                resolve(source.read_finish(result));
            } catch (e) {
                reject(e);
            }
        });
    });
}

function closePreviewStreamQuietlyAsync(stream) {
    if (!stream)
        return Promise.resolve();

    return new Promise(resolve => {
        // The thumbnail queue owns short-lived file streams, so close errors are
        // logged only by the load operation itself; failing to close an already
        // cancelled stream should not turn a harmless Browse close into noise.
        stream.close_async(GLib.PRIORITY_LOW, null, (source, result) => {
            try {
                source.close_finish(result);
            } catch (_e) {
            }
            resolve();
        });
    });
}

async function loadProjectPreviewPixbufAsync(path, cancellable) {
    let stream = null;
    try {
        stream = await readProjectPreviewStreamAsync(path, cancellable);
        return await new Promise((resolve, reject) => {
            // GdkPixbuf performs the expensive image decode asynchronously here,
            // which is the critical part that used to block the Browse dialog
            // while every project card was being created.
            GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(
                stream,
                PROJECT_PREVIEW_STATIC_TEXTURE_SIZE,
                PROJECT_PREVIEW_STATIC_TEXTURE_SIZE,
                true,
                cancellable,
                (_source, result) => {
                    try {
                        resolve(GdkPixbuf.Pixbuf.new_from_stream_finish(result));
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        });
    } finally {
        await closePreviewStreamQuietlyAsync(stream);
    }
}

function createProjectPreviewLoadQueue() {
    const queue = [];
    const activeJobs = new Set();
    let activeCount = 0;
    let idleId = 0;
    let destroyed = false;

    const cancelJob = job => {
        job.cancelled = true;
        job.cancellable.cancel();
    };

    const schedule = () => {
        if (destroyed || idleId)
            return;

        // Loading begins from an idle handler so the dialog has a chance to map
        // and paint its initial placeholder grid before thumbnail work consumes
        // background IO slots.
        idleId = GLib.idle_add(GLib.PRIORITY_LOW, () => {
            idleId = 0;
            pump();
            return GLib.SOURCE_REMOVE;
        });
    };

    const finishJob = job => {
        activeJobs.delete(job);
        activeCount = Math.max(0, activeCount - 1);
        schedule();
    };

    function pump() {
        while (!destroyed && activeCount < PROJECT_THUMBNAIL_CONCURRENCY && queue.length > 0) {
            const job = queue.shift();
            if (job.cancelled)
                continue;

            activeCount++;
            activeJobs.add(job);
            Promise.resolve()
                .then(() => job.run(job.cancellable))
                .catch(error => {
                    if (!job.cancelled && !isPreviewLoadCancelled(error))
                        console.warn(`Hanabi preferences: thumbnail queue job failed: ${error}`);
                })
                .finally(() => finishJob(job));
        }
    }

    return {
        enqueue(run) {
            const job = {
                run,
                cancellable: new Gio.Cancellable(),
                cancelled: false,
            };
            queue.push(job);
            schedule();
            return () => cancelJob(job);
        },
        destroy() {
            destroyed = true;
            if (idleId) {
                GLib.source_remove(idleId);
                idleId = 0;
            }
            queue.splice(0).forEach(cancelJob);
            activeJobs.forEach(cancelJob);
        },
    };
}

class SourceBag {
    constructor() {
        this._ids = new Set();
    }

    add(id) {
        if (id)
            this._ids.add(id);
        return id;
    }

    forget(id) {
        if (id)
            this._ids.delete(id);
    }

    clear() {
        for (const id of this._ids)
            GLib.source_remove(id);
        this._ids.clear();
    }
}

class AdaptiveTileLayout {
    constructor(minTileSize, maxTileSize) {
        this._minTileSize = minTileSize;
        this._maxTileSize = Math.max(minTileSize, maxTileSize);
    }

    get minTileSize() {
        return this._minTileSize;
    }

    get maxTileSize() {
        return this._maxTileSize;
    }

    getMinLogicalTileSize(scaleFactor) {
        return this._logicalThresholds(scaleFactor).minTileSize;
    }

    compute(viewportWidth, itemCount, fallbackColumns, currentLayout = null, scaleFactor = 1) {
        const thresholds = this._logicalThresholds(scaleFactor);

        if (itemCount <= 0)
            return this._createLayout(1, thresholds.minTileSize, thresholds);

        if (viewportWidth <= 0) {
            const columns = Math.max(1, fallbackColumns);
            return this._createLayout(columns, thresholds.minTileSize, thresholds);
        }

        /*
         * This is intentionally the same layout contract as the standalone GIF
         * wall: GTK measures in logical pixels, while the knobs are physical
         * preview sizes. Existing columns are kept while still inside the range
         * so scrollbar and resize jitter do not cause constant grid reshuffles.
         */
        let columns = 0;
        if (currentLayout !== null && currentLayout.scaleFactor === thresholds.scaleFactor) {
            const currentColumns = Math.max(1, currentLayout.columns);
            const currentTileSize = viewportWidth / currentColumns;
            if (currentTileSize >= thresholds.minTileSize && currentTileSize <= thresholds.maxTileSize)
                return this._createLayout(currentColumns, Math.max(1, currentTileSize), thresholds);

            columns = currentTileSize > thresholds.maxTileSize
                ? Math.ceil(viewportWidth / thresholds.maxTileSize)
                : Math.floor(viewportWidth / thresholds.minTileSize);
        }

        if (columns <= 0)
            columns = Math.ceil(viewportWidth / thresholds.maxTileSize);

        const boundedColumns = Math.max(1, columns);
        const tileSize = Math.max(1, viewportWidth / boundedColumns);
        return this._createLayout(boundedColumns, tileSize, thresholds);
    }

    _logicalThresholds(scaleFactor) {
        const normalizedScaleFactor = Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1;
        const minTileSize = Math.max(1, Math.ceil(this._minTileSize / normalizedScaleFactor));
        const maxTileSize = Math.max(minTileSize, Math.floor(this._maxTileSize / normalizedScaleFactor));
        return {
            scaleFactor: normalizedScaleFactor,
            minTileSize,
            maxTileSize,
        };
    }

    _createLayout(columns, tileSize, thresholds) {
        return {
            columns,
            tileSize,
            scaleFactor: thresholds.scaleFactor,
            minLogicalTileSize: thresholds.minTileSize,
            maxLogicalTileSize: thresholds.maxTileSize,
        };
    }
}

class ProjectPreviewTile {
    constructor(project, previewQueue, onPaintableChanged = null) {
        this.project = project;
        this._previewQueue = previewQueue;
        this._onPaintableChanged = onPaintableChanged;
        this._sources = new SourceBag();
        this._paintable = null;
        this._cancelLoad = null;
        this._loadToken = 0;
        this._startedUsec = 0;
        this._visibleIndex = 0;
        this._started = false;
    }

    get paintable() {
        return this._paintable;
    }

    get isGif() {
        return projectPreviewIsGif(this.project.previewPath);
    }

    ensureStarted(visibleIndex, delayMs = 0) {
        this._visibleIndex = visibleIndex;
        if (this._started)
            return;

        this.start(delayMs);
    }

    start(delayMs = 0) {
        this.stop();
        this._started = true;

        if (!this.project.previewPath)
            return;

        if (delayMs <= 0) {
            this._startNow();
            return;
        }

        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.round(delayMs), () => {
            this._sources.forget(id);
            this._startNow();
            return GLib.SOURCE_REMOVE;
        });
        this._sources.add(id);
    }

    stop() {
        this._sources.clear();
        this._cancelLoad?.();
        this._cancelLoad = null;
        this._loadToken++;

        if (this._paintable !== null) {
            const paintable = this._paintable;
            this._paintable = null;

            if (this.isGif && paintable.stop)
                paintable.stop();

            this._notifyPaintableChanged();
        }

        this._startedUsec = 0;
        this._started = false;
    }

    _startNow() {
        if (!this.project.previewPath)
            return;

        if (this.isGif && HanabiGif?.GifPaintable) {
            this._startedUsec = GLib.get_monotonic_time();
            this._paintable = createNativeGifPaintableForFile(
                Gio.File.new_for_path(this.project.previewPath),
                this._computeFramePhaseMs(this._visibleIndex)
            );
            this._notifyPaintableChanged();
            return;
        }

        this._loadStaticTexture();
    }

    _loadStaticTexture() {
        const path = this.project.previewPath;
        if (!path || !this._previewQueue)
            return;

        const loadToken = ++this._loadToken;
        this._cancelLoad = this._previewQueue.enqueue(async cancellable => {
            try {
                const pixbuf = await loadProjectPreviewPixbufAsync(path, cancellable);
                if (cancellable.is_cancelled() || loadToken !== this._loadToken)
                    return;

                this._paintable = Gdk.Texture.new_for_pixbuf(pixbuf);
                this._notifyPaintableChanged();
            } catch (error) {
                if (!isPreviewLoadCancelled(error))
                    console.warn(`Hanabi preferences: failed to load wallpaper thumbnail "${path}": ${error}`);
            } finally {
                if (loadToken === this._loadToken)
                    this._cancelLoad = null;
            }
        });
    }

    _computeFramePhaseMs(index) {
        if (PROJECT_PREVIEW_MAX_FRAME_PHASE_MS <= 1)
            return 0;

        return (index * 13) % PROJECT_PREVIEW_MAX_FRAME_PHASE_MS;
    }

    _notifyPaintableChanged() {
        this._onPaintableChanged?.(this);
    }
}

const ProjectPreviewWall = GObject.registerClass(
class ProjectPreviewWall extends Gtk.Widget {
    _init(layout, fallbackColumns) {
        super._init({
            hexpand: true,
            vexpand: false,
            overflow: Gtk.Overflow.HIDDEN,
        });

        this._layout = layout;
        this._fallbackColumns = fallbackColumns;
        this._tiles = [];
        this._lastLayout = null;
        this._lastLoggedLayoutKey = '';
        this._paintableSignalIds = new Map();
        this._selectedPath = '';
        this._onActivate = null;
        this._onContextMenu = null;
        this._tileOffset = new Graphene.Point();
        this._tileBounds = new Graphene.Rect();
        this._selectionRects = Array.from({length: 4}, () => new Graphene.Rect());
        this._placeholderColor = new Gdk.RGBA({red: 0.20, green: 0.20, blue: 0.20, alpha: 0.28});
        this._selectedColor = new Gdk.RGBA({red: 0.20, green: 0.48, blue: 0.95, alpha: 0.92});

        const primaryGesture = new Gtk.GestureClick({button: PROJECT_CARD_PRIMARY_BUTTON});
        primaryGesture.connect('released', (_gesture, _nPress, x, y) => {
            const tile = this.tileAt(x, y);
            if (tile)
                this._onActivate?.(tile.project);
        });
        this.add_controller(primaryGesture);

        const secondaryGesture = new Gtk.GestureClick({button: PROJECT_CARD_SECONDARY_BUTTON});
        secondaryGesture.connect('pressed', (_gesture, _nPress, x, y) => {
            const tile = this.tileAt(x, y);
            if (tile)
                this._onContextMenu?.(tile.project, x, y);
        });
        this.add_controller(secondaryGesture);

        this.connect('notify::scale-factor', () => {
            this._lastLayout = null;
            this._lastLoggedLayoutKey = '';
            this.queue_resize();
            this.queue_draw();
        });
    }

    setCallbacks(onActivate, onContextMenu) {
        this._onActivate = onActivate;
        this._onContextMenu = onContextMenu;
    }

    setTiles(tiles) {
        this._disconnectPaintables();
        this._tiles = tiles;
        this.syncPaintables();
        this.queue_resize();
        this.queue_draw();
    }

    setSelectedPath(path) {
        this._selectedPath = path ?? '';
        this.queue_draw();
    }

    syncPaintables() {
        const activePaintables = new Set();

        /*
         * Every animated GIF invalidates one native paintable. The wall keeps
         * those signal connections centralized so each frame redraws this
         * single widget instead of waking a full tree of Gtk.Picture children.
         */
        for (const tile of this._tiles) {
            const paintable = tile.paintable;
            if (paintable === null)
                continue;

            activePaintables.add(paintable);
            if (this._paintableSignalIds.has(paintable))
                continue;

            const contentsId = paintable.connect('invalidate-contents', () => this.queue_draw());
            const sizeId = paintable.connect('invalidate-size', () => {
                this.queue_resize();
                this.queue_draw();
            });
            this._paintableSignalIds.set(paintable, [contentsId, sizeId]);
        }

        for (const [paintable, signalIds] of Array.from(this._paintableSignalIds.entries())) {
            if (activePaintables.has(paintable))
                continue;

            for (const signalId of signalIds)
                paintable.disconnect(signalId);
            this._paintableSignalIds.delete(paintable);
        }
    }

    tileAt(x, y) {
        const layout = this._computeLayoutForWidth(this.get_width());
        if (layout.tileSize <= 0)
            return null;

        const column = Math.floor(x / layout.tileSize);
        const row = Math.floor(y / layout.tileSize);
        if (column < 0 || column >= layout.columns || row < 0)
            return null;

        const index = row * layout.columns + column;
        return this._tiles[index] ?? null;
    }

    vfunc_get_request_mode() {
        return Gtk.SizeRequestMode.HEIGHT_FOR_WIDTH;
    }

    vfunc_measure(orientation, forSize) {
        const scaleFactor = this._getScaleFactor();
        const minLogicalTileSize = this._layout.getMinLogicalTileSize(scaleFactor);

        if (orientation === Gtk.Orientation.HORIZONTAL) {
            const naturalColumns = Math.max(1, Math.min(this._tiles.length || 1, this._fallbackColumns));
            const naturalWidth = naturalColumns * minLogicalTileSize;
            return [minLogicalTileSize, naturalWidth, -1, -1];
        }

        const width = forSize > 0 ? forSize : this._fallbackColumns * minLogicalTileSize;
        const layout = this._layout.compute(
            width,
            this._tiles.length,
            this._fallbackColumns,
            this._lastLayout,
            scaleFactor
        );
        const rows = Math.max(1, Math.ceil(this._tiles.length / layout.columns));
        const height = Math.ceil(rows * layout.tileSize);
        return [height, height, -1, -1];
    }

    vfunc_snapshot(snapshot) {
        const layout = this._computeLayoutForWidth(this.get_width());
        this._lastLayout = layout;
        this._logLayoutChange(this.get_width(), layout);

        this._tiles.forEach((tile, index) => {
            const column = index % layout.columns;
            const row = Math.floor(index / layout.columns);
            const x = column * layout.tileSize;
            const y = row * layout.tileSize;

            snapshot.save();
            this._tileOffset.init(x, y);
            snapshot.translate(this._tileOffset);

            if (tile.paintable)
                tile.paintable.snapshot(snapshot, layout.tileSize, layout.tileSize);
            else
                this._appendTilePlaceholder(snapshot, layout.tileSize);

            if (tile.project.path === this._selectedPath)
                this._appendSelectionBorder(snapshot, layout.tileSize);

            snapshot.restore();
        });
    }

    _computeLayoutForWidth(width) {
        return this._layout.compute(
            width,
            this._tiles.length,
            this._fallbackColumns,
            this._lastLayout,
            this._getScaleFactor()
        );
    }

    _appendTilePlaceholder(snapshot, tileSize) {
        this._tileBounds.init(0, 0, tileSize, tileSize);
        snapshot.append_color(this._placeholderColor, this._tileBounds);
    }

    _appendSelectionBorder(snapshot, tileSize) {
        const thickness = Math.max(2, Math.round(3 / this._getScaleFactor()));
        this._selectionRects[0].init(0, 0, tileSize, thickness);
        this._selectionRects[1].init(0, tileSize - thickness, tileSize, thickness);
        this._selectionRects[2].init(0, 0, thickness, tileSize);
        this._selectionRects[3].init(tileSize - thickness, 0, thickness, tileSize);

        for (const rect of this._selectionRects)
            snapshot.append_color(this._selectedColor, rect);
    }

    _disconnectPaintables() {
        for (const [paintable, signalIds] of this._paintableSignalIds) {
            for (const signalId of signalIds)
                paintable.disconnect(signalId);
        }
        this._paintableSignalIds.clear();
    }

    _logLayoutChange(width, layout) {
        const physicalTileSize = layout.tileSize * layout.scaleFactor;
        const key = `${width}:${layout.columns}:${layout.tileSize}:${layout.scaleFactor}`;
        if (key === this._lastLoggedLayoutKey)
            return;

        this._lastLoggedLayoutKey = key;
        console.log(
            `Hanabi preferences: preview-layout width=${width} columns=${layout.columns} ` +
            `tile_size_logical=${layout.tileSize.toFixed(2)} ` +
            `tile_size_physical=${physicalTileSize.toFixed(2)} ` +
            `scale_factor=${layout.scaleFactor} ` +
            `min_tile_size_physical=${this._layout.minTileSize} ` +
            `max_tile_size_physical=${this._layout.maxTileSize} ` +
            `min_tile_size_logical=${layout.minLogicalTileSize} ` +
            `max_tile_size_logical=${layout.maxLogicalTileSize} gap=0`
        );
    }

    _getScaleFactor() {
        const scaleFactor = this.get_scale_factor();
        return Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1;
    }
});

function openProjectDirectory(project) {
    const path = project?.path;
    if (!path) {
        console.warn('Hanabi preferences: cannot open wallpaper folder because the project path is empty');
        return;
    }

    // Launch the project directory URI through GIO instead of shelling out so
    // the desktop chooses the user's configured file manager and reports real
    // launch failures back through the async finish callback.
    const uri = Gio.File.new_for_path(path).get_uri();
    try {
        Gio.AppInfo.launch_default_for_uri_async(uri, null, null, (_source, result) => {
            try {
                Gio.AppInfo.launch_default_for_uri_finish(result);
            } catch (error) {
                console.warn(`Hanabi preferences: failed to open wallpaper folder "${path}": ${error}`);
            }
        });
    } catch (error) {
        console.warn(`Hanabi preferences: failed to open wallpaper folder "${path}": ${error}`);
    }
}

function getProjectPreviewWindowDimension(anchorWidget) {
    const scaleFactor = anchorWidget?.get_scale_factor?.() ?? 1;
    const safeScaleFactor = Number.isFinite(scaleFactor) && scaleFactor > 0
        ? scaleFactor
        : 1;
    const width = Math.max(1, Math.round(PROJECT_PREVIEW_WINDOW_BASE_WIDTH / safeScaleFactor));
    const height = Math.max(1, Math.round(PROJECT_PREVIEW_WINDOW_BASE_HEIGHT / safeScaleFactor));
    return `${width}:${height}`;
}

function getGpuPipelinePreviewEnvironment(settings) {
    let gpuPipeline = 'auto';
    try {
        gpuPipeline = settings?.get_string('gpu-pipeline') ?? 'auto';
    } catch (_e) {
        gpuPipeline = 'auto';
    }

    return GpuPipelinePolicy.environmentToEnvVector(
        GpuPipelinePolicy.buildRendererEnvironment(gpuPipeline).environment
    );
}

function launchProjectPreview(project, windowed, anchorWidget = null, settings = null) {
    const path = project?.path;
    if (!path) {
        console.warn('Hanabi preferences: cannot preview wallpaper because the project path is empty');
        return;
    }

    if (!GLib.file_test(rendererScriptPath, GLib.FileTest.IS_REGULAR)) {
        console.warn(`Hanabi preferences: cannot preview wallpaper because renderer.js was not found at "${rendererScriptPath}"`);
        return;
    }

    const argv = [
        'gjs',
        rendererScriptPath,
        '--standalone',
        '--nohide',
    ];
    if (windowed)
        argv.push('-W', getProjectPreviewWindowDimension(anchorWidget));
    argv.push('--project-path', path);

    const previewEnvironment = getGpuPipelinePreviewEnvironment(settings);
    const launchArgv = previewEnvironment.length > 0
        ? ['env', ...previewEnvironment, ...argv]
        : argv;

    // Use a small shell wrapper only for the same stderr/stdout tee behavior as
    // the documented manual preview command. Every argv segment is shell-quoted
    // before joining so wallpaper paths with spaces or quotes stay data, not
    // shell syntax.
    const command = `${launchArgv.map(arg => GLib.shell_quote(arg)).join(' ')} 2>&1 | tee run.log`;
    try {
        const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.NONE});
        launcher.set_cwd(extensionDir);
        launcher.spawnv(['/bin/sh', '-c', command]);
    } catch (error) {
        const mode = windowed ? 'window' : 'fullscreen';
        console.warn(`Hanabi preferences: failed to launch ${mode} wallpaper preview for "${path}": ${error}`);
    }
}

function createProjectPreviewContextMenu(preview, settings) {
    const actions = new Gio.SimpleActionGroup();
    let currentProject = null;
    const openFolderAction = new Gio.SimpleAction({name: 'open-folder'});
    openFolderAction.connect('activate', () => openProjectDirectory(currentProject));
    actions.add_action(openFolderAction);
    const previewWindowAction = new Gio.SimpleAction({name: 'preview-window'});
    previewWindowAction.connect('activate', () => launchProjectPreview(currentProject, true, preview, settings));
    actions.add_action(previewWindowAction);
    const previewFullscreenAction = new Gio.SimpleAction({name: 'preview-fullscreen'});
    previewFullscreenAction.connect('activate', () => launchProjectPreview(currentProject, false, null, settings));
    actions.add_action(previewFullscreenAction);
    preview.insert_action_group('thumbnail', actions);

    const menu = new Gio.Menu();
    const previewMenu = new Gio.Menu();
    previewMenu.append(_('Window Preview'), 'thumbnail.preview-window');
    previewMenu.append(_('Fullscreen Preview'), 'thumbnail.preview-fullscreen');

    // Keep both launch modes grouped under one submenu so the thumbnail context
    // menu stays compact as more wallpaper maintenance actions are added.
    menu.append_submenu(_('Preview'), previewMenu);
    menu.append(_('Open Wallpaper Folder'), 'thumbnail.open-folder');

    const popover = Gtk.PopoverMenu.new_from_model(menu);
    popover.set_parent(preview);
    preview.connect('destroy', () => popover.unparent());

    return {
        popup(project, x, y) {
            if (!project)
                return;

            currentProject = project;
            // Pointing the popover at the exact tile position preserves the old
            // right-click behavior even though the grid is now one custom widget.
            popover.set_pointing_to(new Gdk.Rectangle({
                x: Math.round(x),
                y: Math.round(y),
                width: 1,
                height: 1,
            }));
            popover.popup();
        },
    };
}

function stripScenePropertyMarkup(text) {
    if (typeof text !== 'string')
        return '';

    return text
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<hr\s*\/?>/gi, '\n')
        .replace(/<[^>]*>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, '\'')
        .split('\n')
        .map(line => line.replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .join('\n')
        .trim();
}

function formatScenePropertyLabel(text, fallback = _('Untitled')) {
    const label = stripScenePropertyMarkup(text);
    return label || fallback;
}

function decodeScenePropertyMarkupEntities(text) {
    return text
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, '\'');
}

/**
 * Repair the small Pango markup subset emitted for scene property labels.
 *
 * @param {string} markup Markup generated from loose Workshop HTML.
 * @returns {string} Markup with stray closers ignored and open tags balanced.
 */
function normalizeScenePropertyMarkupNesting(markup) {
    // Workshop metadata is authored as loose HTML, but Gtk.Label consumes the
    // much stricter Pango markup subset. One unmatched or wrongly ordered close
    // tag makes Pango reject the entire label, so this pass only repairs the
    // tags we intentionally emit while leaving already-escaped text untouched.
    const tagPattern = /<(\/?)(big|b|i|small|u)\s*>|<a\b[^>]*>|<\/a>/gi;
    const stack = [];
    const chunks = [];
    let match = null;
    let lastIndex = 0;

    while ((match = tagPattern.exec(markup)) !== null) {
        const fullMatch = match[0];
        const closing = fullMatch.startsWith('</') || match[1] === '/';
        const tagName = (match[2] ?? 'a').toLowerCase();
        chunks.push(markup.slice(lastIndex, match.index));
        lastIndex = tagPattern.lastIndex;

        if (!closing) {
            stack.push({name: tagName, markup: fullMatch});
            chunks.push(fullMatch);
            continue;
        }

        let openIndex = -1;
        for (let index = stack.length - 1; index >= 0; index--) {
            if (stack[index].name === tagName) {
                openIndex = index;
                break;
            }
        }

        if (openIndex < 0)
            continue;

        const temporarilyClosed = stack.splice(openIndex + 1);
        for (let index = temporarilyClosed.length - 1; index >= 0; index--)
            chunks.push(`</${temporarilyClosed[index].name}>`);

        const closedTag = stack.pop();
        chunks.push(`</${closedTag.name}>`);

        temporarilyClosed.forEach(tag => {
            stack.push(tag);
            chunks.push(tag.markup);
        });
    }

    chunks.push(markup.slice(lastIndex));
    for (let index = stack.length - 1; index >= 0; index--)
        chunks.push(`</${stack[index].name}>`);

    return chunks.join('');
}

function formatScenePropertyMarkup(text, fallback = _('Untitled')) {
    const source = typeof text === 'string' && text.trim() !== '' ? text : fallback;
    const tagPlaceholders = new Map([
        ['<big>', '__SCENE_BIG_OPEN__'],
        ['</big>', '__SCENE_BIG_CLOSE__'],
        ['<b>', '__SCENE_B_OPEN__'],
        ['</b>', '__SCENE_B_CLOSE__'],
        ['<i>', '__SCENE_I_OPEN__'],
        ['</i>', '__SCENE_I_CLOSE__'],
        ['<small>', '__SCENE_SMALL_OPEN__'],
        ['</small>', '__SCENE_SMALL_CLOSE__'],
        ['<u>', '__SCENE_U_OPEN__'],
        ['</u>', '__SCENE_U_CLOSE__'],
    ]);
    const placeholderMarkup = new Map([...tagPlaceholders.entries()].map(([markup, token]) => [token, markup]));
    const linkPlaceholders = [];
    const openLinkStack = [];

    let markup = source
        .replace(/\r\n?/g, '\n')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<hr\s*\/?>/gi, '\n')
        .replace(/<a\b[^>]*>\s*<img\b[^>]*\/?>\s*<\/a>/gi, '\n')
        .replace(/<\/?(p|div|center)\b[^>]*>/gi, '\n')
        .replace(/<img\b[^>]*>/gi, '\n')
        .replace(/<a\b([^>]*)>|<\/a>/gi, (match, attributes) => {
            if (match.startsWith('</')) {
                const index = openLinkStack.pop();
                return index !== undefined ? `__SCENE_LINK_${index}_CLOSE__` : '';
            }

            const quotedHrefMatch = attributes.match(/\bhref\s*=\s*(['"])(.*?)\1/i);
            const unquotedHrefMatch = attributes.match(/\bhref\s*=\s*([^\s>]+)/i);
            const href = decodeScenePropertyMarkupEntities(
                quotedHrefMatch?.[2] ?? unquotedHrefMatch?.[1] ?? ''
            ).trim();
            const index = linkPlaceholders.length;
            linkPlaceholders.push(href);
            openLinkStack.push(index);
            return `__SCENE_LINK_${index}_OPEN__`;
        })
        .replace(/<\s*(\/?)\s*(big|b|i|small|u)\s*>/gi, (_match, closing, tagName) => {
            const key = `<${closing ? '/' : ''}${tagName.toLowerCase()}>`;
            return tagPlaceholders.get(key) ?? '';
        })
        .replace(/<[^>]*>/g, ' ');

    markup = decodeScenePropertyMarkupEntities(markup)
        .split('\n')
        .map(line => line.replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .join('\n')
        .trim();

    if (!markup)
        return GLib.markup_escape_text(fallback, -1);

    markup = GLib.markup_escape_text(markup, -1);

    for (const [token, replacement] of placeholderMarkup.entries())
        markup = markup.split(token).join(replacement);

    linkPlaceholders.forEach((href, index) => {
        const escapedHref = GLib.markup_escape_text(href, -1);
        markup = markup
            .split(`__SCENE_LINK_${index}_OPEN__`)
            .join(href ? `<a href="${escapedHref}">` : '<u>')
            .split(`__SCENE_LINK_${index}_CLOSE__`)
            .join(href ? '</a>' : '</u>');
    });

    return normalizeScenePropertyMarkupNesting(markup);
}

function scenePropertyUsesCenteredMarkup(text) {
    return typeof text === 'string' && /<center\b/i.test(text);
}

/**
 * Read one attribute from loose Workshop HTML.
 *
 * @param {string} attributes Raw attribute text from an opening tag.
 * @param {string} attributeName Attribute name to read.
 * @returns {string} Decoded attribute value, or an empty string.
 */
function parseScenePropertyHtmlAttribute(attributes, attributeName) {
    const quotedMatch = attributes.match(new RegExp(`\\b${attributeName}\\s*=\\s*(['"])(.*?)\\1`, 'i'));
    const unquotedMatch = attributes.match(new RegExp(`\\b${attributeName}\\s*=\\s*([^\\s>]+)`, 'i'));
    return decodeScenePropertyMarkupEntities(
        quotedMatch?.[2] ?? unquotedMatch?.[1] ?? ''
    ).trim();
}

/**
 * Extract href from an opening anchor tag.
 *
 * @param {string} anchorTag Raw `<a ...>` tag text.
 * @returns {string} Decoded href value, or an empty string.
 */
function parseScenePropertyAnchorHref(anchorTag) {
    const attributes = anchorTag.match(/<a\b([^>]*)>/i)?.[1] ?? '';
    return parseScenePropertyHtmlAttribute(attributes, 'href');
}

/**
 * Check whether a scheme-less href is probably an external web URL.
 *
 * @param {string} href Href without an explicit URI scheme.
 * @returns {boolean} True when the href starts with a host-like domain.
 */
function scenePropertyHrefLooksLikeWebHost(href) {
    return /^[a-z0-9-]+(\.[a-z0-9-]+)+(?:[/?#:]|$)/i.test(href);
}

/**
 * Parse one loose HTML image tag into the data needed by the image widget.
 *
 * @param {string} imageTag Raw `<img>` tag text from project metadata.
 * @returns {?object} Image source and optional dimensions, or null.
 */
function parseScenePropertyImageTag(imageTag) {
    const attributes = imageTag.match(/<img\b([^>]*)\/?>/i)?.[1] ?? '';
    const src = parseScenePropertyHtmlAttribute(attributes, 'src');
    const width = Number.parseFloat(parseScenePropertyHtmlAttribute(attributes, 'width'));
    const height = Number.parseFloat(parseScenePropertyHtmlAttribute(attributes, 'height'));

    if (!src)
        return null;

    return {
        src,
        width: Number.isFinite(width) && width > 0 ? Math.round(width) : null,
        height: Number.isFinite(height) && height > 0 ? Math.round(height) : null,
    };
}

/**
 * Locate image blocks while keeping their original positions in rich text.
 *
 * @param {string} text Raw scene property text from project metadata.
 * @returns {object[]} Ordered image blocks with source ranges and image data.
 */
function parseScenePropertyImageBlocks(text) {
    if (typeof text !== 'string')
        return [];

    const blocks = [];
    const imagePattern = /(<a\b[^>]*>)\s*(<img\b[^>]*\/?>)\s*<\/a>|(<img\b[^>]*\/?>)/gi;
    let match = null;

    while ((match = imagePattern.exec(text)) !== null) {
        const image = parseScenePropertyImageTag(match[2] ?? match[3] ?? '');
        if (!image)
            continue;

        const href = parseScenePropertyAnchorHref(match[1] ?? '');
        if (href)
            image.href = href;

        blocks.push({
            start: match.index,
            end: imagePattern.lastIndex,
            image,
        });
    }

    return blocks;
}

function parseScenePropertyImages(text) {
    return parseScenePropertyImageBlocks(text).map(block => block.image);
}

function formatScenePropertyDisplayTitle(text, fallback = _('Untitled')) {
    const label = stripScenePropertyMarkup(text);
    if (label)
        return label;

    return parseScenePropertyImages(text).length > 0 ? '' : fallback;
}

function getInspectorContentMaxWidth(suffixWidth = 0) {
    return Math.max(
        96,
        SCENE_PROPERTY_PANEL_WIDTH - INSPECTOR_ROW_HORIZONTAL_MARGIN - INSPECTOR_ROW_CONTROL_SPACING - suffixWidth - 24
    );
}

function getColorComponentCount(defaultValue) {
    if (typeof defaultValue !== 'string')
        return 3;

    const components = defaultValue
        .trim()
        .split(/[\s,]+/)
        .filter(Boolean);
    return components.length >= 4 ? 4 : 3;
}

function parseScenePropertyColor(value) {
    const rgba = new Gdk.RGBA();
    if (typeof value === 'string') {
        const components = value
            .trim()
            .split(/[\s,]+/)
            .map(component => Number.parseFloat(component))
            .filter(Number.isFinite);

        if (components.length >= 3) {
            rgba.red = components[0];
            rgba.green = components[1];
            rgba.blue = components[2];
            rgba.alpha = components[3] ?? 1.0;
            return rgba;
        }

        try {
            if (rgba.parse(value))
                return rgba;
        } catch (_e) {
        }
    }

    rgba.red = 1.0;
    rgba.green = 1.0;
    rgba.blue = 1.0;
    rgba.alpha = 1.0;
    return rgba;
}

function serializeScenePropertyColor(rgba, defaultValue) {
    const componentCount = getColorComponentCount(defaultValue);
    const components = [
        rgba.red,
        rgba.green,
        rgba.blue,
        rgba.alpha,
    ].slice(0, componentCount);

    return components
        .map(component => {
            const rounded = Math.round(component * 1000000) / 1000000;
            return `${rounded}`;
        })
        .join(' ');
}

function getStepDigits(step) {
    if (typeof step !== 'number' || !Number.isFinite(step))
        return 0;

    const trimmed = `${step}`.replace(/0+$/, '');
    const dotIndex = trimmed.indexOf('.');
    return dotIndex >= 0 ? trimmed.length - dotIndex - 1 : 0;
}

function createProjectBrowserDialog(window, settings) {
    const currentProjectKey = 'project-path';
    const libraryKey = 'change-wallpaper-directory-path';
    const filterStateKey = ProjectBrowserFilterKey.STATE;

    const dialog = new Gtk.Dialog({
        title: _('Choose Wallpaper'),
        transient_for: window,
        modal: true,
        default_width: PROJECT_BROWSER_DIALOG_DEFAULT_WIDTH,
        default_height: PROJECT_BROWSER_DIALOG_DEFAULT_HEIGHT,
    });
    dialog.add_button(_('Close'), Gtk.ResponseType.CLOSE);
    dialog.connect('response', () => dialog.destroy());

    const content = dialog.get_content_area();
    content.set_spacing(12);
    content.set_margin_top(12);
    content.set_margin_bottom(12);
    content.set_margin_start(12);
    content.set_margin_end(12);

    const header = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 8,
    });
    content.append(header);

    const selectedLabel = new Gtk.Label({
        xalign: 0,
        wrap: false,
        ellipsize: Pango.EllipsizeMode.END,
        css_classes: ['heading'],
    });
    const libraryLabel = new Gtk.Label({
        xalign: 0,
        wrap: false,
        ellipsize: Pango.EllipsizeMode.MIDDLE,
        css_classes: ['dim-label'],
    });
    header.append(selectedLabel);
    header.append(libraryLabel);

    const toolbar = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 8,
    });
    const searchRow = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 12,
    });
    const searchEntry = new Gtk.SearchEntry({
        hexpand: true,
        placeholder_text: _('Search wallpapers'),
    });
    // Keep Browse sorting as a dialog-local view choice: it should reorder the
    // currently visible preview wall without changing the shared project loader
    // order that renderer-side rotation and other callers may still depend on.
    const sortOptions = [
        {key: PROJECT_BROWSER_SORT_KEYS.NAME, label: _('Name')},
        {key: PROJECT_BROWSER_SORT_KEYS.FILE_SIZE, label: _('File size')},
        {key: PROJECT_BROWSER_SORT_KEYS.UPDATED_TIME, label: _('Last updated')},
    ];
    const savedSortKey = normalizeProjectBrowserSortKey(
        settings.get_string(PROJECT_BROWSER_SORT_SETTINGS_KEY)
    );
    const savedSortIndex = Math.max(0, sortOptions.findIndex(option => option.key === savedSortKey));
    const sortLabel = new Gtk.Label({
        label: _('Sort'),
        valign: Gtk.Align.CENTER,
    });
    const sortDropdown = new Gtk.DropDown({
        model: Gtk.StringList.new(sortOptions.map(option => option.label)),
        selected: savedSortIndex,
        valign: Gtk.Align.CENTER,
    });
    const filterButton = new Gtk.MenuButton({
        label: _('Filter'),
        valign: Gtk.Align.CENTER,
    });
    const filterPopover = new Gtk.Popover({
        position: Gtk.PositionType.BOTTOM,
        has_arrow: true,
    });
    const filterPopoverScrolled = new Gtk.ScrolledWindow({
        min_content_width: 280,
        min_content_height: 360,
        max_content_height: 420,
        hscrollbar_policy: Gtk.PolicyType.NEVER,
    });
    const filterPopoverContent = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 12,
        margin_top: 12,
        margin_bottom: 12,
        margin_start: 12,
        margin_end: 12,
    });
    const filterPopoverHeader = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 12,
    });
    const filterPopoverDescription = new Gtk.Label({
        label: _('Show or hide wallpapers by category'),
        xalign: 0,
        wrap: true,
        hexpand: true,
        css_classes: ['dim-label'],
    });
    const filterResetButton = new Gtk.Button({
        label: _('Reset'),
        valign: Gtk.Align.START,
    });
    const filterSectionsBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 12,
    });
    filterPopoverHeader.append(filterPopoverDescription);
    filterPopoverHeader.append(filterResetButton);
    filterPopoverContent.append(filterPopoverHeader);
    filterPopoverContent.append(filterSectionsBox);
    filterPopoverScrolled.set_child(filterPopoverContent);
    filterPopover.set_child(filterPopoverScrolled);
    filterButton.set_popover(filterPopover);
    searchRow.append(searchEntry);
    searchRow.append(sortLabel);
    searchRow.append(sortDropdown);
    searchRow.append(filterButton);
    toolbar.append(searchRow);
    content.append(toolbar);

    const body = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 12,
        hexpand: true,
        vexpand: true,
    });
    content.append(body);

    const browserPane = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        hexpand: true,
        vexpand: true,
    });
    body.append(browserPane);

    const scrolled = new Gtk.ScrolledWindow({
        min_content_height: 600,
        hscrollbar_policy: Gtk.PolicyType.NEVER,
        hexpand: true,
        vexpand: true,
    });
    const previewLayout = new AdaptiveTileLayout(
        PROJECT_PREVIEW_MIN_TILE_SIZE,
        PROJECT_PREVIEW_MAX_TILE_SIZE
    );
    const previewWall = new ProjectPreviewWall(previewLayout, PROJECT_PREVIEW_INITIAL_COLUMNS);
    scrolled.set_child(previewWall);
    browserPane.append(scrolled);

    const placeholder = new Gtk.Label({
        xalign: 0,
        wrap: true,
        css_classes: ['dim-label'],
    });
    browserPane.append(placeholder);

    const inspectorPane = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 8,
        width_request: SCENE_PROPERTY_PANEL_WIDTH,
        hexpand: false,
        vexpand: true,
    });
    inspectorPane.set_size_request(SCENE_PROPERTY_PANEL_WIDTH, -1);
    body.append(inspectorPane);

    const inspectorScrolled = new Gtk.ScrolledWindow({
        hexpand: false,
        vexpand: true,
        min_content_width: SCENE_PROPERTY_PANEL_WIDTH,
        max_content_width: SCENE_PROPERTY_PANEL_WIDTH,
        hscrollbar_policy: Gtk.PolicyType.NEVER,
        propagate_natural_width: false,
    });
    inspectorPane.append(inspectorScrolled);

    const inspectorStack = new Gtk.Stack({
        hexpand: false,
        vexpand: true,
    });
    inspectorScrolled.set_child(inspectorStack);

    const inspectorMessage = new Gtk.Label({
        xalign: 0,
        yalign: 0,
        wrap: true,
        css_classes: ['dim-label'],
        margin_top: 12,
        margin_bottom: 12,
        margin_start: 12,
        margin_end: 12,
    });
    inspectorStack.add_named(inspectorMessage, 'message');

    const inspectorContent = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 12,
        hexpand: false,
        margin_top: 4,
        margin_bottom: 4,
    });
    inspectorStack.add_named(inspectorContent, 'content');

    let currentQuery = '';
    let currentInspectorProject = null;
    let currentInspectorOverrides = {};
    let currentProjectsByPath = new Map();
    let currentFilterTagOptions = getProjectFilterTagOptions([]);
    let inspectorSections = [];
    let currentSortKey = savedSortKey;
    const sceneImageSession = new Soup.Session();
    const previewTiles = [];
    const previewTileByPath = new Map();
    const projectSortMetadata = new Map();
    // The Browse dialog owns one thumbnail queue. Destroying the dialog cancels
    // pending preview IO and prevents late async callbacks from touching widgets
    // that GTK has already removed from the preferences window.
    const previewQueue = createProjectPreviewLoadQueue();
    let syncingFilterControls = false;
    const filterControls = {
        type: new Map(),
        contentrating: new Map(),
        tags: new Map(),
    };

    const previewContextMenu = createProjectPreviewContextMenu(previewWall, settings);
    previewWall.setCallbacks(project => {
        settings.set_string(currentProjectKey, project.path);
        syncSelectionState();
        buildInspector(project);
    }, (project, x, y) => previewContextMenu.popup(project, x, y));

    const clearPreviewTiles = () => {
        previewTileByPath.forEach(tile => tile.stop());
        previewTileByPath.clear();
        previewTiles.length = 0;
        previewWall.setTiles([]);
    };

    dialog.connect('destroy', () => {
        clearPreviewTiles();
        previewQueue.destroy();
    });

    const getProjectSortMetadata = project => {
        let metadata = projectSortMetadata.get(project.path);
        if (metadata)
            return metadata;

        // The sort metadata is cached per rebuild because file-size sorting has
        // to walk project directories recursively, while name and timestamp can
        // be reused by every GTK sort callback for the same wallpaper row.
        metadata = {
            sizeBytes: null,
            updatedTimeUs: null,
        };
        projectSortMetadata.set(project.path, metadata);
        return metadata;
    };

    const getProjectSortSize = project => {
        const metadata = getProjectSortMetadata(project);
        if (metadata.sizeBytes === null)
            metadata.sizeBytes = queryProjectDirectorySize(project.path);
        return metadata.sizeBytes;
    };

    const getProjectSortUpdatedTime = project => {
        const metadata = getProjectSortMetadata(project);
        if (metadata.updatedTimeUs === null)
            metadata.updatedTimeUs = queryProjectLastUpdatedTime(project);
        return metadata.updatedTimeUs;
    };

    const compareProjectsForCurrentSort = (left, right) => {
        if (currentSortKey === PROJECT_BROWSER_SORT_KEYS.FILE_SIZE) {
            const sizeComparison = compareNumbersDescending(
                getProjectSortSize(left),
                getProjectSortSize(right)
            );
            return sizeComparison || compareProjectTitles(left, right);
        }

        if (currentSortKey === PROJECT_BROWSER_SORT_KEYS.UPDATED_TIME) {
            const timeComparison = compareNumbersDescending(
                getProjectSortUpdatedTime(left),
                getProjectSortUpdatedTime(right)
            );
            return timeComparison || compareProjectTitles(left, right);
        }

        return compareProjectTitles(left, right);
    };

    const projectMatchesCurrentFilters = project => {
        const query = currentQuery.trim().toLowerCase();
        if (query && !buildProjectSearchText(project).includes(query))
            return false;

        return projectMatchesFilter(
            project,
            getProjectFilterFromSettings(settings, currentFilterTagOptions)
        );
    };

    const clearChildren = box => {
        while (true) {
            const child = box.get_first_child();
            if (!child)
                break;
            box.remove(child);
        }
    };

    const createFilterSection = (title, sectionKey, items) => {
        const section = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
        });
        const heading = new Gtk.Label({
            label: title,
            xalign: 0,
            css_classes: ['heading'],
        });
        const list = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 4,
        });

        items.forEach(item => {
            const button = new Gtk.CheckButton({
                label: item.label,
                halign: Gtk.Align.START,
            });
            button.connect('toggled', checkbox => {
                if (syncingFilterControls)
                    return;

                const filterState = getProjectFilterFromSettings(settings, currentFilterTagOptions);
                filterState[sectionKey][item.key] = checkbox.active;
                setProjectFilterInSettings(settings, filterState, currentFilterTagOptions);
            });
            filterControls[sectionKey].set(item.key, button);
            list.append(button);
        });

        section.append(heading);
        section.append(list);
        return section;
    };

    const syncFilterControls = () => {
        const filterState = getProjectFilterFromSettings(settings, currentFilterTagOptions);
        syncingFilterControls = true;
        Object.entries(filterControls).forEach(([sectionKey, controls]) => {
            controls.forEach((button, key) => {
                button.active = filterState[sectionKey][key] !== false;
            });
        });
        syncingFilterControls = false;
    };

    const rebuildFilterControls = projects => {
        currentFilterTagOptions = getProjectFilterTagOptions(projects);
        Object.values(filterControls).forEach(controls => controls.clear());
        clearChildren(filterSectionsBox);

        filterSectionsBox.append(createFilterSection(_('Type'), 'type', [
            {key: ProjectType.SCENE, label: formatProjectTypeLabel(ProjectType.SCENE)},
            {key: ProjectType.WEB, label: formatProjectTypeLabel(ProjectType.WEB)},
            {key: ProjectType.VIDEO, label: formatProjectTypeLabel(ProjectType.VIDEO)},
        ]));
        filterSectionsBox.append(createFilterSection(_('Age'), 'contentrating', ProjectContentRatings.map(rating => ({
            key: rating,
            label: formatProjectContentRatingLabel(rating),
        }))));
        filterSectionsBox.append(createFilterSection(_('Genre'), 'tags', currentFilterTagOptions.map(tag => ({
            key: tag,
            label: formatProjectGenreLabel(tag),
        }))));

        syncFilterControls();
    };

    filterResetButton.connect('clicked', () => {
        setProjectFilterInSettings(settings, null, currentFilterTagOptions);
    });

    const resolveSceneImageFile = source => {
        if (!source || /^https?:\/\//i.test(source))
            return null;

        if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source))
            return Gio.File.new_for_uri(source);

        if (GLib.path_is_absolute(source))
            return Gio.File.new_for_path(source);

        if (!currentInspectorProject?.path)
            return null;

        return Gio.File.new_for_path(GLib.build_filenamev([currentInspectorProject.path, source]));
    };

    const normalizeSceneImageLinkUri = href => {
        if (!href)
            return null;

        const uri = href.trim();
        if (!uri)
            return null;

        if (/^[a-z][a-z0-9+.-]*:/i.test(uri))
            return uri;

        if (uri.startsWith('//'))
            return `https:${uri}`;

        if (!scenePropertyHrefLooksLikeWebHost(uri))
            return null;

        return `https://${uri}`;
    };

    const openSceneImageLink = uri => {
        try {
            Gio.AppInfo.launch_default_for_uri_async(uri, null, null, (_source, result) => {
                try {
                    Gio.AppInfo.launch_default_for_uri_finish(result);
                } catch (error) {
                    console.warn(`Hanabi preferences: failed to open scene image link "${uri}": ${error}`);
                }
            });
        } catch (error) {
            console.warn(`Hanabi preferences: failed to open scene image link "${uri}": ${error}`);
        }
    };

    const calculateSceneImageSizeRequest = (image, naturalWidth, naturalHeight, maxWidth) => {
        naturalWidth = Math.max(1, naturalWidth);
        naturalHeight = Math.max(1, naturalHeight);
        let requestedWidth = image.width ?? naturalWidth;
        let requestedHeight = image.height ?? naturalHeight;

        // Gtk.Picture reports a vertical minimum of zero for paintables with no
        // explicit height request. The inspector rows use those minimum sizes,
        // so remote Workshop images without width/height metadata can decode
        // successfully yet still receive no visible allocation. Always derive a
        // concrete size from the decoded texture while preserving aspect ratio.
        if (image.width && !image.height)
            requestedHeight = Math.round(naturalHeight * image.width / naturalWidth);
        else if (!image.width && image.height)
            requestedWidth = Math.round(naturalWidth * image.height / naturalHeight);

        const scale = Math.min(1, maxWidth / Math.max(1, requestedWidth));
        return {
            width: Math.max(1, Math.round(requestedWidth * scale)),
            height: Math.max(1, Math.round(requestedHeight * scale)),
        };
    };

    const createSceneImageWidget = (image, maxWidth, centered = false) => {
        const alignment = centered ? Gtk.Align.CENTER : Gtk.Align.START;
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
            halign: alignment,
            valign: Gtk.Align.CENTER,
        });
        const picture = new Gtk.Picture({
            can_shrink: true,
            content_fit: Gtk.ContentFit.SCALE_DOWN,
            halign: alignment,
            visible: false,
        });
        const spinner = new Gtk.Spinner({
            spinning: true,
            halign: alignment,
        });
        const errorLabel = new Gtk.Label({
            xalign: centered ? 0.5 : 0,
            wrap: true,
            visible: false,
            justify: centered ? Gtk.Justification.CENTER : Gtk.Justification.LEFT,
            css_classes: ['dim-label'],
            label: _('Image unavailable'),
        });
        const linkUri = normalizeSceneImageLinkUri(image.href);
        let destroyed = false;
        const requestCancellable = new Gio.Cancellable();
        let activeNativeGifPaintable = null;
        let nativeGifSignalIds = [];

        picture.set_size_request(
            Math.min(image.width ?? maxWidth, maxWidth),
            image.height ?? -1
        );
        box.append(spinner);
        box.append(picture);
        box.append(errorLabel);

        const showError = () => {
            if (destroyed)
                return;

            spinner.visible = false;
            picture.visible = false;
            errorLabel.visible = true;
        };

        const applyPaintable = (paintable, naturalWidth, naturalHeight) => {
            if (destroyed)
                return;

            const sizeRequest = calculateSceneImageSizeRequest(image, naturalWidth, naturalHeight, maxWidth);
            spinner.visible = false;
            errorLabel.visible = false;
            picture.visible = true;
            picture.set_size_request(sizeRequest.width, sizeRequest.height);
            picture.set_paintable(paintable);
        };

        const disconnectNativeGifPaintable = () => {
            if (activeNativeGifPaintable === null)
                return;

            for (const signalId of nativeGifSignalIds)
                activeNativeGifPaintable.disconnect(signalId);
            nativeGifSignalIds = [];
        };

        const stopNativeGifPaintable = () => {
            if (activeNativeGifPaintable === null)
                return;

            const paintable = activeNativeGifPaintable;
            disconnectNativeGifPaintable();
            activeNativeGifPaintable = null;
            paintable.stop?.();
        };

        const applyTexture = texture => {
            stopNativeGifPaintable();
            applyPaintable(texture, texture.get_width(), texture.get_height());
        };

        const updateNativeGifSize = paintable => {
            const intrinsicWidth = paintable.get_intrinsic_width?.() ?? 0;
            const intrinsicHeight = paintable.get_intrinsic_height?.() ?? 0;
            const naturalWidth = intrinsicWidth > 0 ? intrinsicWidth : image.width ?? maxWidth;
            const naturalHeight = intrinsicHeight > 0 ? intrinsicHeight : image.height ?? naturalWidth;
            applyPaintable(paintable, naturalWidth, naturalHeight);
        };

        const applyNativeGifPaintable = paintable => {
            if (paintable === null)
                return false;

            if (destroyed) {
                paintable.stop?.();
                return false;
            }

            stopNativeGifPaintable();
            activeNativeGifPaintable = paintable;
            /*
             * Rich-media GIFs now share the same native playback path as the
             * preview wall instead of running a second GJS Gly.Loader frame
             * loop. The C paintable owns exactly one current texture and drops
             * each decoded GlyFrame immediately, so the inspector can animate
             * GIF metadata without retaining one JS wrapper per frame.
             */
            nativeGifSignalIds = [
                paintable.connect('invalidate-size', () => updateNativeGifSize(paintable)),
            ];
            updateNativeGifSize(paintable);
            return true;
        };

        const applyNativeGifFile = file => {
            if (!imageSourceLooksGif(image.src))
                return false;

            return applyNativeGifPaintable(createNativeGifPaintableForFile(file));
        };

        const applyNativeGifBytes = bytes => {
            if (destroyed || !bytesLookLikeGif(bytes))
                return false;

            return applyNativeGifPaintable(createNativeGifPaintableForBytes(bytes));
        };

        const applyImageBytes = bytes => {
            applyTexture(Gdk.Texture.new_from_bytes(bytes));
        };

        box.connect('destroy', () => {
            destroyed = true;
            requestCancellable.cancel();
            stopNativeGifPaintable();
            picture.set_paintable(null);
        });

        if (linkUri) {
            const gesture = new Gtk.GestureClick({button: PROJECT_CARD_PRIMARY_BUTTON});
            gesture.connect('released', (_gesture, _nPress, _x, _y) => openSceneImageLink(linkUri));
            box.add_controller(gesture);
            box.tooltip_text = linkUri;
            box.set_cursor(Gdk.Cursor.new_from_name('pointer', null));
        }

        try {
            if (/^https?:\/\//i.test(image.src)) {
                loadCachedRemoteSceneImageBytesAsync(sceneImageSession, image.src, requestCancellable)
                    .then(bytes => {
                        if (destroyed)
                            return;

                        if (applyNativeGifBytes(bytes))
                            return;

                        applyImageBytes(bytes);
                    })
                    .catch(error => {
                        if (destroyed || isPreviewLoadCancelled(error))
                            return;

                        console.warn(`Hanabi preferences: failed to load scene image "${image.src}": ${error}`);
                        showError();
                    });
            } else {
                const file = resolveSceneImageFile(image.src);
                if (!file) {
                    showError();
                    return box;
                }
                if (applyNativeGifFile(file))
                    return box;

                applyTexture(Gdk.Texture.new_from_file(file));
            }
        } catch (_error) {
            showError();
        }

        return box;
    };

    const buildSceneMarkupContentWidget = (text, fallback, maxWidth) => {
        const centered = scenePropertyUsesCenteredMarkup(text);
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 8,
            hexpand: false,
            valign: Gtk.Align.CENTER,
        });

        let hasContent = false;
        const appendTextSegment = segment => {
            const plainText = formatScenePropertyDisplayTitle(segment, '');
            if (!plainText)
                return;

            const textLabel = new Gtk.Label({
                label: formatScenePropertyMarkup(segment, ''),
                use_markup: true,
                xalign: centered ? 0.5 : 0,
                wrap: true,
                wrap_mode: Pango.WrapMode.WORD_CHAR,
                justify: centered ? Gtk.Justification.CENTER : Gtk.Justification.LEFT,
                max_width_chars: 36,
                selectable: true,
                tooltip_text: plainText,
                width_request: maxWidth,
            });
            box.append(textLabel);
            hasContent = true;
        };

        // Wallpaper Engine authors often use HTML as a tiny layout language:
        // text, linked image, more text, another image. Keeping that original
        // sequence makes ABOUT/Donate/Workshop sections readable, while the
        // formatter above remains responsible only for the strict Pango markup
        // accepted by Gtk.Label.
        let offset = 0;
        parseScenePropertyImageBlocks(text).forEach(block => {
            appendTextSegment(text.slice(offset, block.start));
            box.append(createSceneImageWidget(block.image, maxWidth, centered));
            hasContent = true;
            offset = block.end;
        });
        appendTextSegment(typeof text === 'string' ? text.slice(offset) : '');

        if (!hasContent)
            appendTextSegment(fallback);

        const clamp = new Adw.Clamp({
            maximum_size: maxWidth,
            tightening_threshold: maxWidth,
            hexpand: false,
            halign: Gtk.Align.START,
        });
        clamp.set_child(box);
        return clamp;
    };

    const createInspectorControlRow = ({title, tooltipText, contentWidget, suffixWidget = null}) => {
        const row = new Adw.PreferencesRow({
            title: title || _('Untitled'),
        });
        row.tooltip_text = tooltipText || null;

        const box = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 12,
            hexpand: true,
            margin_top: 12,
            margin_bottom: 12,
            margin_start: 12,
            margin_end: 12,
        });
        contentWidget.hexpand = true;
        contentWidget.halign = Gtk.Align.FILL;
        box.append(contentWidget);
        if (suffixWidget) {
            suffixWidget.valign = Gtk.Align.CENTER;
            suffixWidget.halign = Gtk.Align.END;
            box.append(suffixWidget);
        }
        row.set_child(box);
        return row;
    };

    const updateLabels = () => {
        selectedLabel.label = `${_('Current')}: ${formatProjectSubtitle(settings.get_string(currentProjectKey))}`;
        selectedLabel.tooltip_text = settings.get_string(currentProjectKey);
        libraryLabel.label = `${_('Steam Library')}: ${formatLibrarySubtitle(settings.get_string(libraryKey))}`;
        libraryLabel.tooltip_text = formatLibrarySubtitle(settings.get_string(libraryKey));
    };

    const clearInspectorContent = () => {
        while (true) {
            const child = inspectorContent.get_first_child();
            if (!child)
                break;
            inspectorContent.remove(child);
        }
        inspectorSections = [];
    };

    const openPathChooser = (property, row) => {
        const chooser = new Gtk.FileChooserDialog({
            title: formatScenePropertyLabel(property.text, property.name),
            transient_for: dialog,
            modal: true,
            action: property.type === ScenePropertyType.DIRECTORY
                ? Gtk.FileChooserAction.SELECT_FOLDER
                : Gtk.FileChooserAction.OPEN,
        });
        chooser.add_button(_('Cancel'), Gtk.ResponseType.CANCEL);
        chooser.add_button(_('Open'), Gtk.ResponseType.ACCEPT);

        if (row.text) {
            const currentFile = Gio.File.new_for_path(row.text);
            if (currentFile.query_exists(null))
                chooser.set_file(currentFile);
        }

        chooser.connect('response', (chooserDialog, responseId) => {
            if (responseId === Gtk.ResponseType.ACCEPT) {
                const file = chooserDialog.get_file();
                row.text = file?.get_path() ?? '';
            }
            chooserDialog.destroy();
        });
        chooser.show();
    };

    const persistInspectorOverrides = (property, rawValue) => {
        if (!currentInspectorProject)
            return;

        const nextValue = normalizeScenePropertyValue(property.type, rawValue, property.defaultValue);
        if (areScenePropertyValuesEqual(property.type, nextValue, property.defaultValue))
            delete currentInspectorOverrides[property.name];
        else
            currentInspectorOverrides[property.name] = nextValue;

        currentInspectorOverrides = setProjectPropertyOverrides(
            settings,
            currentInspectorProject,
            currentInspectorOverrides
        );
        updateInspectorVisibility();
    };

    function createInspectorPropertyWidget(property) {
        const title = formatScenePropertyDisplayTitle(property.text, property.name);
        const currentValue = normalizeScenePropertyValue(
            property.type,
            currentInspectorOverrides[property.name],
            property.defaultValue
        );

        switch (property.type) {
        case ScenePropertyType.BOOL: {
            const contentMaxWidth = getInspectorContentMaxWidth(INSPECTOR_NARROW_CONTROL_WIDTH);
            const contentWidget = buildSceneMarkupContentWidget(property.text, property.name, contentMaxWidth);
            const toggle = new Gtk.Switch({
                active: currentValue,
                valign: Gtk.Align.CENTER,
            });
            toggle.connect('notify::active', () => {
                persistInspectorOverrides(property, toggle.active);
            });
            return createInspectorControlRow({
                title: title || property.name,
                tooltipText: title,
                contentWidget,
                suffixWidget: toggle,
            });
        }
        case ScenePropertyType.SLIDER: {
            const contentMaxWidth = getInspectorContentMaxWidth(INSPECTOR_WIDE_CONTROL_WIDTH);
            const contentWidget = buildSceneMarkupContentWidget(property.text, property.name, contentMaxWidth);
            const lower = property.min ?? 0;
            const upper = property.max ?? Math.max(lower + 1, currentValue);
            const digits = getStepDigits(property.step);
            const adjustment = new Gtk.Adjustment({
                lower: Math.min(lower, upper),
                upper: Math.max(lower, upper),
                step_increment: property.step ?? 0.1,
                page_increment: Math.max((property.step ?? 0.1) * 10, 1),
                value: currentValue,
            });
            const scale = new Gtk.Scale({
                orientation: Gtk.Orientation.HORIZONTAL,
                adjustment,
                digits,
                draw_value: true,
                value_pos: Gtk.PositionType.RIGHT,
                width_request: 180,
                valign: Gtk.Align.CENTER,
            });
            adjustment.connect('value-changed', () => {
                persistInspectorOverrides(property, adjustment.value);
            });
            return createInspectorControlRow({
                title: title || property.name,
                tooltipText: title,
                contentWidget,
                suffixWidget: scale,
            });
        }
        case ScenePropertyType.COMBO: {
            const contentMaxWidth = getInspectorContentMaxWidth(INSPECTOR_WIDE_CONTROL_WIDTH);
            const contentWidget = buildSceneMarkupContentWidget(property.text, property.name, contentMaxWidth);
            if (property.options.length === 0) {
                const unsupported = new Gtk.Label({
                    label: _('No options available'),
                    xalign: 1,
                    wrap: true,
                    css_classes: ['dim-label'],
                });
                return createInspectorControlRow({
                    title: title || property.name,
                    tooltipText: title,
                    contentWidget,
                    suffixWidget: unsupported,
                });
            }

            const labels = property.options.map(option => formatScenePropertyLabel(option.text, option.value));
            const dropdown = new Gtk.DropDown({
                model: Gtk.StringList.new(labels),
                valign: Gtk.Align.CENTER,
                width_request: 180,
            });
            const currentIndex = Math.max(
                0,
                property.options.findIndex(option => option.value === `${currentValue}`)
            );
            dropdown.selected = currentIndex >= 0 ? currentIndex : 0;
            dropdown.connect('notify::selected', () => {
                const option = property.options[dropdown.selected];
                if (option)
                    persistInspectorOverrides(property, option.value);
            });
            return createInspectorControlRow({
                title: title || property.name,
                tooltipText: title,
                contentWidget,
                suffixWidget: dropdown,
            });
        }
        case ScenePropertyType.COLOR: {
            const contentMaxWidth = getInspectorContentMaxWidth(INSPECTOR_NARROW_CONTROL_WIDTH);
            const contentWidget = buildSceneMarkupContentWidget(property.text, property.name, contentMaxWidth);
            const colorButton = new Gtk.ColorButton({
                valign: Gtk.Align.CENTER,
                use_alpha: getColorComponentCount(property.defaultValue) >= 4,
            });
            colorButton.set_rgba(parseScenePropertyColor(currentValue));
            colorButton.connect('color-set', button => {
                persistInspectorOverrides(
                    property,
                    serializeScenePropertyColor(button.get_rgba(), property.defaultValue)
                );
            });
            return createInspectorControlRow({
                title: title || property.name,
                tooltipText: title,
                contentWidget,
                suffixWidget: colorButton,
            });
        }
        case ScenePropertyType.TEXT_INPUT:
        case ScenePropertyType.FILE:
        case ScenePropertyType.DIRECTORY:
        case ScenePropertyType.SCENE_TEXTURE: {
            const contentMaxWidth = getInspectorContentMaxWidth(INSPECTOR_WIDE_CONTROL_WIDTH);
            const contentWidget = buildSceneMarkupContentWidget(property.text, property.name, contentMaxWidth);
            const entry = new Gtk.Entry({
                text: currentValue,
                valign: Gtk.Align.CENTER,
                width_request: 180,
            });
            entry.connect('notify::text', entryWidget => {
                persistInspectorOverrides(property, entryWidget.text);
            });

            let suffixWidget = entry;
            if ([ScenePropertyType.FILE, ScenePropertyType.DIRECTORY, ScenePropertyType.SCENE_TEXTURE].includes(property.type)) {
                const entryBox = new Gtk.Box({
                    orientation: Gtk.Orientation.HORIZONTAL,
                    spacing: 6,
                    valign: Gtk.Align.CENTER,
                });
                const browseButton = new Gtk.Button({
                    icon_name: 'document-open-symbolic',
                    valign: Gtk.Align.CENTER,
                });
                browseButton.connect('clicked', () => openPathChooser(property, entry));
                entryBox.append(entry);
                entryBox.append(browseButton);
                suffixWidget = entryBox;
            }
            return createInspectorControlRow({
                title: title || property.name,
                tooltipText: title,
                contentWidget,
                suffixWidget,
            });
        }
        case ScenePropertyType.TEXT: {
            const contentMaxWidth = getInspectorContentMaxWidth();
            const contentWidget = buildSceneMarkupContentWidget(property.text, property.name, contentMaxWidth);
            return createInspectorControlRow({
                title: title || property.name,
                tooltipText: null,
                contentWidget,
            });
        }
        default:
        {
            const contentMaxWidth = getInspectorContentMaxWidth();
            const contentWidget = buildSceneMarkupContentWidget(property.text, property.name, contentMaxWidth);
            const unsupported = new Gtk.Label({
                label: _('Unsupported setting type'),
                xalign: 1,
                wrap: true,
                css_classes: ['dim-label'],
            });
            return createInspectorControlRow({
                title: title || property.name,
                tooltipText: title,
                contentWidget,
                suffixWidget: unsupported,
            });
        }
        }
    }

    /**
     * Applies project.json display conditions to the inspector layout.
     *
     * The inspector rows are created once in project.json order, so hiding
     * inactive rows is intentionally preferred over rebuilding the visible
     * subset. GTK removes hidden rows from layout without changing sibling
     * order, which keeps language-driven configuration groups visually correct
     * while preserving every visible property's relative order.
     */
    function updateInspectorVisibility() {
        if (!currentInspectorProject)
            return;

        const valueMap = buildScenePropertyValueMap(currentInspectorProject, currentInspectorOverrides);
        const enabledMap = new Map();

        inspectorSections.forEach(section => {
            const groupVisible = section.groupProperty
                ? isScenePropertyVisible(currentInspectorProject, section.groupProperty, valueMap, enabledMap)
                : true;
            let visibleRowCount = 0;

            section.rows.forEach(entry => {
                const rowVisible = groupVisible && isScenePropertyVisible(
                    currentInspectorProject,
                    entry.property,
                    valueMap,
                    enabledMap
                );
                entry.widget.visible = rowVisible;
                entry.widget.sensitive = rowVisible;
                if (rowVisible)
                    visibleRowCount++;
            });

            if (section.groupHeader) {
                section.groupHeader.visible = groupVisible && visibleRowCount > 0;
                section.groupHeader.sensitive = groupVisible;
            }
            section.groupWidget.visible = groupVisible && visibleRowCount > 0;
            section.groupWidget.sensitive = groupVisible;
        });
    }

    function showInspectorMessage(project, message) {
        clearInspectorContent();
        currentInspectorProject = project ?? null;
        currentInspectorOverrides = {};
        inspectorMessage.label = message;
        inspectorStack.set_visible_child_name('message');
    }

    function buildInspector(project) {
        clearInspectorContent();
        currentInspectorProject = project;
        currentInspectorOverrides = getProjectPropertyOverrides(settings, project);

        if ((project.sceneProperties?.length ?? 0) === 0) {
            showInspectorMessage(project, _('This wallpaper has no configurable properties'));
            return;
        }

        const sections = [];
        let currentSection = {
            groupProperty: null,
            properties: [],
        };
        sections.push(currentSection);

        for (const property of project.sceneProperties) {
            if (property.type === ScenePropertyType.GROUP) {
                currentSection = {
                    groupProperty: property,
                    properties: [],
                };
                sections.push(currentSection);
                continue;
            }
            currentSection.properties.push(property);
        }

        inspectorSections = sections.map(section => {
            const groupWidget = new Adw.PreferencesGroup();
            let groupHeader = null;
            if (section.groupProperty) {
                const fullTitle = formatScenePropertyDisplayTitle(section.groupProperty.text, section.groupProperty.name);
                groupHeader = buildSceneMarkupContentWidget(
                    section.groupProperty.text,
                    section.groupProperty.name,
                    getInspectorContentMaxWidth()
                );
                groupHeader.tooltip_text = fullTitle || null;
                groupHeader.add_css_class('heading');
                groupHeader.margin_top = 6;
                inspectorContent.append(groupHeader);
            }

            const rows = [];
            section.properties.forEach(property => {
                const widget = createInspectorPropertyWidget(property);
                rows.push({property, widget});
                groupWidget.add(widget);
            });
            inspectorContent.append(groupWidget);
            return {
                ...section,
                groupHeader,
                groupWidget,
                rows,
            };
        });

        inspectorStack.set_visible_child_name('content');
        updateInspectorVisibility();
    }

    const refreshInspector = () => {
        const currentPath = settings.get_string(currentProjectKey);
        const project = currentProjectsByPath.get(currentPath) ?? loadProject(currentPath);
        if (!project) {
            showInspectorMessage(null, _('Select a wallpaper to configure its properties'));
            return;
        }
        buildInspector(project);
    };

    const syncSelectionState = () => {
        const currentPath = settings.get_string(currentProjectKey);
        previewWall.setSelectedPath(currentPath);
        updateLabels();
    };

    const getVisibleProjects = () => Array.from(currentProjectsByPath.values())
        .filter(project => projectMatchesCurrentFilters(project))
        .sort(compareProjectsForCurrentSort);

    const rebuildPreviewTiles = () => {
        const visibleProjects = getVisibleProjects();
        const visibleProjectPaths = new Set(visibleProjects.map(project => project.path));

        for (const [path, tile] of Array.from(previewTileByPath.entries())) {
            if (visibleProjectPaths.has(path))
                continue;

            tile.stop();
            previewTileByPath.delete(path);
        }

        previewTiles.length = 0;
        visibleProjects.forEach((project, index) => {
            let tile = previewTileByPath.get(project.path) ?? null;
            const previousPreviewPath = tile?.project.previewPath ?? null;
            if (tile !== null && previousPreviewPath !== project.previewPath) {
                tile.stop();
                previewTileByPath.delete(project.path);
                tile = null;
            }

            if (tile === null) {
                tile = new ProjectPreviewTile(project, previewQueue, () => {
                    previewWall.syncPaintables();
                    previewWall.queue_draw();
                });
                previewTileByPath.set(project.path, tile);
            } else {
                tile.project = project;
            }

            previewTiles.push(tile);
            tile.ensureStarted(
                index,
                tile.isGif ? index * PROJECT_PREVIEW_START_STAGGER_MS : 0
            );
        });

        previewWall.setTiles(previewTiles);
    };

    const updateEmptyState = () => {
        const visibleChildren = previewTiles.length;
        const hasVisibleCards = visibleChildren > 0;
        scrolled.visible = hasVisibleCards;
        placeholder.visible = !hasVisibleCards;
        if (!hasVisibleCards)
            placeholder.label = currentProjectsByPath.size > 0 ? _('No wallpapers match your search or filters') : placeholder.label;
    };

    const rebuild = () => {
        const projects = listProjects(settings.get_string(libraryKey));
        currentProjectsByPath = new Map(projects.map(project => [project.path, project]));
        projectSortMetadata.clear();
        rebuildFilterControls(projects);

        const hasProjects = projects.length > 0;
        scrolled.visible = hasProjects;
        placeholder.visible = !hasProjects;
        if (!hasProjects) {
            clearPreviewTiles();
            placeholder.label = settings.get_string(libraryKey)
                ? _('No wallpaper projects were found in this Steam library')
                : _('Choose a Steam library first');
            updateLabels();
            refreshInspector();
            return;
        }

        rebuildPreviewTiles();
        updateEmptyState();
        syncSelectionState();
        refreshInspector();
    };

    sortDropdown.connect('notify::selected', dropdown => {
        currentSortKey = normalizeProjectBrowserSortKey(sortOptions[dropdown.selected]?.key);
        settings.set_string(PROJECT_BROWSER_SORT_SETTINGS_KEY, currentSortKey);
        rebuildPreviewTiles();
        updateEmptyState();
        syncSelectionState();
    });

    searchEntry.connect('search-changed', entry => {
        currentQuery = entry.text ?? '';
        rebuildPreviewTiles();
        updateEmptyState();
    });

    connectTracked(window, settings, `changed::${currentProjectKey}`, () => {
        syncSelectionState();
        refreshInspector();
    });
    connectTracked(window, settings, `changed::${libraryKey}`, () => {
        rebuild();
    });
    connectTracked(window, settings, `changed::${filterStateKey}`, () => {
        syncFilterControls();
        rebuildPreviewTiles();
        updateEmptyState();
    });
    showInspectorMessage(null, _('Select a wallpaper to configure its properties'));
    rebuild();
    return dialog;
}

export function prefsRowProjectChooser(window, prefsGroup) {
    const settings = window._settings;
    const currentProjectKey = 'project-path';

    const row = new Adw.ActionRow({
        title: _('Wallpaper'),
        subtitle: formatProjectSubtitle(settings.get_string(currentProjectKey)),
    });
    prefsGroup.add(row);

    const button = new Adw.ButtonContent({
        icon_name: 'view-grid-symbolic',
        label: _('Browse'),
    });
    row.activatable_widget = button;
    row.add_suffix(button);

    row.connect('activated', () => {
        const dialog = createProjectBrowserDialog(window, settings);
        dialog.present();
    });

    connectTracked(window, settings, `changed::${currentProjectKey}`, () => {
        row.subtitle = formatProjectSubtitle(settings.get_string(currentProjectKey));
    });
}
