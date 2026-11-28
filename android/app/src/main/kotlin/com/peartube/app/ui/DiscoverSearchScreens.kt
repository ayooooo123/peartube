package com.peartube.app.ui

import android.graphics.BitmapFactory
import android.util.LruCache
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.peartube.app.AppModel
import com.peartube.app.CINEMA_GENRES
import com.peartube.app.CinemaDiscoverItem
import com.peartube.app.CinemaTitleMeta
import com.peartube.app.CreatorSuggestion
import com.peartube.app.DiscoverCreator
import com.peartube.app.DiscoverFeedError
import com.peartube.app.DiscoverItem
import com.peartube.app.DiscoverTab
import com.peartube.app.ExternalDiscoveryApi
import com.peartube.app.ExternalImageCache
import com.peartube.app.ExternalVideoPick
import com.peartube.app.GlobalHit
import com.peartube.app.LibraryCatalog
import com.peartube.app.LibraryTile
import com.peartube.app.MUSIC_MOODS
import com.peartube.app.MusicState
import com.peartube.app.PeekTarget
import com.peartube.app.Room
import com.peartube.app.RumbleCandidate
import com.peartube.app.Screen
import com.peartube.app.SearchScope
import com.peartube.app.SearchSource
import com.peartube.app.SoulseekAlbumCandidate
import com.peartube.app.SoulseekShelfFolder
import com.peartube.app.SoundCloudCandidate
import com.peartube.app.SuggestedAlbum
import com.peartube.app.SuggestedArtist
import com.peartube.app.SuggestedSong
import com.peartube.app.TrackRow
import com.peartube.app.YouTubeCandidate
import com.peartube.app.findIn
import com.peartube.app.fold
import com.peartube.app.imdbBackdropUrl
import com.peartube.app.imdbPosterUrl
import com.peartube.app.isSearchLink
import com.peartube.app.plural
import com.peartube.app.resolveLoopbackThumbUrl
import com.peartube.app.sleeveHash
import com.peartube.app.smartParseYouTubeCandidate
import com.peartube.app.tileFactsLine
import com.peartube.app.toTrackItem
import com.peartube.app.toTrackItems
import com.peartube.shared.clock
import com.peartube.shared.formatBytes
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import java.net.HttpURLConnection
import java.net.URL
import java.util.Locale

private val DISCOVER_TOPICS = listOf("Documentaries", "Tech", "Science", "Film Essays", "Podcasts", "Gaming")
private val DISCOVER_SOURCE_FILTERS = listOf(
    "" to "All",
    "youtube" to "YouTube",
    "soundcloud" to "SoundCloud",
    "rumble" to "Rumble",
)

private object LoopbackThumbCache {
    private val cache = object : LruCache<String, ImageBitmap>(64) {}

    fun get(url: String): ImageBitmap? = synchronized(cache) { cache.get(url) }

    fun put(url: String, bitmap: ImageBitmap) {
        synchronized(cache) { cache.put(url, bitmap) }
    }
}

private suspend fun fetchLoopbackBitmap(url: String): ImageBitmap? = withContext(Dispatchers.IO) {
    LoopbackThumbCache.get(url)?.let { return@withContext it }
    var conn: HttpURLConnection? = null
    try {
        conn = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = 5_000
            readTimeout = 8_000
        }
        if (conn.responseCode !in 200..299) return@withContext null
        val decoded = conn.inputStream.use { input ->
            BitmapFactory.decodeStream(input)?.asImageBitmap()
        }
        if (decoded != null) {
            LoopbackThumbCache.put(url, decoded)
        }
        decoded
    } catch (ce: CancellationException) {
        throw ce
    } catch (_: Exception) {
        null
    } finally {
        try {
            conn?.disconnect()
        } catch (_: Exception) {
            // Ignore socket cleanup errors.
        }
    }
}

private fun sourceAccentColor(source: String): Color = when (source.lowercase(Locale.ROOT)) {
    "youtube" -> SourceYoutube
    "soundcloud" -> SourceSoundCloud
    "rumble" -> SourceRumble
    else -> Brand
}

private fun sourceDisplayLabel(source: String): String = when (source.lowercase(Locale.ROOT)) {
    "youtube" -> "YouTube"
    "soundcloud" -> "SoundCloud"
    "rumble" -> "Rumble"
    else -> source.replaceFirstChar { it.uppercase(Locale.ROOT) }.ifBlank { "Source" }
}

private fun formatRelativePublished(publishedAtMs: Long): String {
    if (publishedAtMs <= 0L) return ""
    val diffMs = (System.currentTimeMillis() - publishedAtMs).coerceAtLeast(0L)
    val mins = diffMs / 60_000L
    val hours = mins / 60L
    val days = hours / 24L
    return when {
        mins < 60L -> if (mins <= 1L) "Just now" else "${mins}m ago"
        hours < 24L -> "${hours}h ago"
        days < 30L -> "${days}d ago"
        days < 365L -> "${days / 30L}mo ago"
        else -> "${days / 365L}y ago"
    }
}

@Composable
private fun LoopbackThumbnail(
    apiUrl: String?,
    path: String,
    source: String,
    audioOnly: Boolean,
    contentDescription: String?,
    modifier: Modifier = Modifier,
) {
    val resolvedUrl = remember(apiUrl, path) { resolveLoopbackThumbUrl(apiUrl, path) }
    val bitmap by produceState<ImageBitmap?>(
        initialValue = resolvedUrl?.let { LoopbackThumbCache.get(it) },
        key1 = resolvedUrl,
    ) {
        value = if (resolvedUrl != null) fetchLoopbackBitmap(resolvedUrl) else null
    }
    val tint = sourceAccentColor(source)
    Box(
        modifier = modifier.background(CardElevated),
        contentAlignment = Alignment.Center,
    ) {
        val loaded = bitmap
        if (loaded != null) {
            Image(
                bitmap = loaded,
                contentDescription = contentDescription,
                contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxSize(),
            )
        } else {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .background(tint.copy(alpha = 0.14f)),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    imageVector = if (audioOnly) ListenIcon else WatchIcon,
                    contentDescription = null,
                    tint = tint.copy(alpha = 0.78f),
                    modifier = Modifier.size(32.dp),
                )
            }
        }
    }
}

@Composable
private fun LoopbackAvatar(
    apiUrl: String?,
    path: String,
    name: String,
    source: String,
    modifier: Modifier = Modifier,
) {
    val resolvedUrl = remember(apiUrl, path) { resolveLoopbackThumbUrl(apiUrl, path) }
    val bitmap by produceState<ImageBitmap?>(
        initialValue = resolvedUrl?.let { LoopbackThumbCache.get(it) },
        key1 = resolvedUrl,
    ) {
        value = if (resolvedUrl != null) fetchLoopbackBitmap(resolvedUrl) else null
    }
    val tint = sourceAccentColor(source)
    Box(
        modifier = modifier
            .clip(CircleShape)
            .background(tint.copy(alpha = 0.22f)),
        contentAlignment = Alignment.Center,
    ) {
        val loaded = bitmap
        if (loaded != null) {
            Image(
                bitmap = loaded,
                contentDescription = name,
                contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxSize(),
            )
        } else {
            Text(
                text = name.trim().firstOrNull()?.uppercase() ?: "?",
                color = tint,
                fontSize = 11.sp,
                fontWeight = FontWeight.Bold,
            )
        }
    }
}

@Composable
private fun ExternalAvatar(
    url: String,
    name: String,
    accent: Color = Brand,
    modifier: Modifier = Modifier,
) {
    val bitmap by produceState<ImageBitmap?>(
        initialValue = url.takeIf { it.isNotBlank() }?.let { ExternalImageCache.get(it) },
        key1 = url,
    ) {
        value = if (url.isNotBlank()) ExternalImageCache.load(url) else null
    }
    Box(
        modifier = modifier
            .clip(CircleShape)
            .background(accent.copy(alpha = 0.20f))
            .border(1.dp, GlassBorder, CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        val loaded = bitmap
        if (loaded != null) {
            Image(
                bitmap = loaded,
                contentDescription = name,
                contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxSize(),
            )
        } else {
            Text(
                text = name.trim().firstOrNull()?.uppercase() ?: "?",
                color = Pearl,
                fontSize = 16.sp,
                fontWeight = FontWeight.Bold,
            )
        }
    }
}

@Composable
internal fun ExternalArtwork(
    url: String,
    title: String,
    cornerRadius: androidx.compose.ui.unit.Dp = 10.dp,
    modifier: Modifier = Modifier,
) {
    val shape = RoundedCornerShape(cornerRadius)
    val bitmap by produceState<ImageBitmap?>(
        initialValue = url.takeIf { it.isNotBlank() }?.let { ExternalImageCache.get(it) },
        key1 = url,
    ) {
        value = if (url.isNotBlank()) ExternalImageCache.load(url) else null
    }
    Box(
        modifier = modifier
            .clip(shape)
            .background(CardElevated),
        contentAlignment = Alignment.Center,
    ) {
        val loaded = bitmap
        if (loaded != null) {
            Image(
                bitmap = loaded,
                contentDescription = title,
                contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxSize(),
            )
        } else {
            Icon(
                imageVector = MusicNoteIcon,
                contentDescription = null,
                tint = Brand.copy(alpha = 0.72f),
                modifier = Modifier.size(22.dp),
            )
        }
    }
}

@Composable
fun DiscoverScreen(
    model: AppModel,
    catalog: LibraryCatalog,
    onOpenTitle: (String) -> Unit = { model.pushScreen(Screen.TitleDetail(it)) },
    topPadding: Dp = 12.dp,
    bottomPadding: Dp = 28.dp,
) {
    val status by model.status.collectAsState()
    val entries by model.entries.collectAsState()
    val haptics = LocalHapticFeedback.current
    val acquireJobs by model.acquireJobs.collectAsState()
    val visitedShelves by model.visitedShelves.collectAsState()
    val creators by model.discoverCreators.collectAsState()
    val feed by model.discoverFeed.collectAsState()
    val browse by model.discoverBrowse.collectAsState()
    val loading by model.discoverLoading.collectAsState()
    val followBusy by model.discoverFollowBusy.collectAsState()
    val discoverError by model.discoverError.collectAsState()
    val sourceFilter by model.discoverSourceFilter.collectAsState()
    val creatorFilter by model.discoverCreatorFilter.collectAsState()
    val activeTopic by model.discoverActiveTopic.collectAsState()
    val submittingIds by model.discoverSubmittingIds.collectAsState()

    val discoverTab by model.discoverTab.collectAsState()
    val musicMood by model.musicDiscoverMood.collectAsState()
    val musicQuery by model.musicDiscoverQuery.collectAsState()
    val musicData by model.musicDiscoverData.collectAsState()
    val musicLoading by model.musicDiscoverLoading.collectAsState()
    val musicError by model.musicDiscoverError.collectAsState()
    val selectedArtist by model.selectedSuggestedArtist.collectAsState()
    val musicState by model.musicState.collectAsState()

    val cinemaGenre by model.cinemaDiscoverGenre.collectAsState()
    val cinemaData by model.cinemaDiscoverData.collectAsState()
    val cinemaLoading by model.cinemaDiscoverLoading.collectAsState()
    val cinemaError by model.cinemaDiscoverError.collectAsState()
    val featuredCreators by model.featuredCreators.collectAsState()
    val externalVideos by model.externalVideos.collectAsState()
    val externalVideosLoading by model.externalVideosLoading.collectAsState()

    var selectedCinemaItem by remember { mutableStateOf<CinemaDiscoverItem?>(null) }
    var showManageFollowing by remember { mutableStateOf(false) }

    // Ensure cinema, music, external videos, and featured creator discovery load smoothly per tab
    LaunchedEffect(discoverTab) {
        if ((discoverTab == DiscoverTab.Music || discoverTab == DiscoverTab.All) &&
            musicData == null &&
            !musicLoading
        ) {
            model.loadMusicDiscover(musicMood, musicQuery)
        }
        if ((discoverTab == DiscoverTab.Cinema || discoverTab == DiscoverTab.All) &&
            cinemaData == null &&
            !cinemaLoading
        ) {
            model.loadCinemaDiscover(cinemaGenre)
        }
        if (discoverTab == DiscoverTab.Videos || discoverTab == DiscoverTab.All) {
            model.loadFeaturedCreatorsIfNeeded()
        }
        if (discoverTab == DiscoverTab.Videos && externalVideos.isEmpty() && !externalVideosLoading) {
            model.loadExternalVideos()
        }
    }

    val apiUrl = status?.apiUrl
    val discovered = status?.discoveredSources.orEmpty()
    val artistNames = remember(catalog.artists) {
        catalog.artists.map { it.name }.filter { it.isNotBlank() && it != "Unknown artist" }
    }
    val libraryIds = remember(entries) {
        entries.map { it.id.lowercase(Locale.ROOT) }.toSet()
    }
    val libraryTilesByImdb = remember(catalog.videos) {
        catalog.videos.mapNotNull { t -> t.imdb?.let { it to t } }.toMap()
    }
    val activeAcquireIds = remember(acquireJobs) {
        acquireJobs.filter { it.isActive }.map { it.id.lowercase(Locale.ROOT) }.filter { it.isNotBlank() }.toSet()
    }
    val followedCreatorIds = remember(creators) { creators.map { it.id }.toSet() }
    val followedCreatorUrls = remember(creators) { creators.map { it.url.lowercase(Locale.ROOT) }.toSet() }
    val followedCreatorKeys = remember(creators) {
        creators.map { "${it.source}:${it.name.lowercase(Locale.ROOT)}" }.toSet()
    }
    val followedHandles = remember(creators) {
        creators.mapNotNull { it.handle.removePrefix("@").lowercase(Locale.ROOT).takeIf { h -> h.isNotEmpty() } }.toSet()
    }

    val unfollowedFeaturedCreators = remember(featuredCreators, followedCreatorIds, followedCreatorUrls, followedCreatorKeys, followedHandles) {
        featuredCreators.filter { fc ->
            val handleNorm = fc.handle.removePrefix("@").lowercase(Locale.ROOT)
            val already = fc.id in followedCreatorIds ||
                fc.url.lowercase(Locale.ROOT) in followedCreatorUrls ||
                "${fc.source}:${fc.name.lowercase(Locale.ROOT)}" in followedCreatorKeys ||
                (handleNorm.isNotEmpty() && handleNorm in followedHandles)
            !already
        }
    }

    val spotlightCinema = remember(cinemaData) {
        cinemaData?.movies?.firstOrNull { it.rating.isNotBlank() && it.backdropUrl.isNotBlank() }
            ?: cinemaData?.series?.firstOrNull { it.rating.isNotBlank() && it.backdropUrl.isNotBlank() }
            ?: cinemaData?.movies?.firstOrNull { it.backdropUrl.isNotBlank() }
            ?: cinemaData?.series?.firstOrNull { it.backdropUrl.isNotBlank() }
            ?: cinemaData?.movies?.firstOrNull()
            ?: cinemaData?.series?.firstOrNull()
    }

    val interleavedTrending = remember(cinemaData, spotlightCinema) {
        val spotId = spotlightCinema?.imdbId
        val m = cinemaData?.movies.orEmpty().filterNot { it.imdbId == spotId }
        val s = cinemaData?.series.orEmpty().filterNot { it.imdbId == spotId }
        val out = ArrayList<CinemaDiscoverItem>(12)
        val maxLen = maxOf(m.size, s.size)
        for (i in 0 until maxLen) {
            if (i < m.size && out.size < 10) out.add(m[i])
            if (i < s.size && out.size < 10) out.add(s[i])
            if (out.size >= 10) break
        }
        out
    }

    val cinemaMoreItems = remember(cinemaData) {
        val extraMovies = cinemaData?.movies.orEmpty().drop(12)
        val extraSeries = cinemaData?.series.orEmpty().drop(12)
        val out = ArrayList<CinemaDiscoverItem>(18)
        val maxLen = maxOf(extraMovies.size, extraSeries.size)
        for (i in 0 until maxLen) {
            if (i < extraMovies.size && out.size < 18) out.add(extraMovies[i])
            if (i < extraSeries.size && out.size < 18) out.add(extraSeries[i])
            if (out.size >= 18) break
        }
        out
    }

    val browsing = activeTopic != null
    val shownItems = remember(browsing, browse, feed, sourceFilter) {
        if (browsing) {
            val all = browse?.items.orEmpty()
            if (sourceFilter.isEmpty()) all else all.filter { it.source == sourceFilter }
        } else {
            feed.items
        }
    }
    val shownErrors = remember(browsing, browse, feed) {
        if (browsing) browse?.errors.orEmpty() else feed.errors
    }

    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(top = topPadding, bottom = bottomPadding),
        verticalArrangement = Arrangement.spacedBy(22.dp),
    ) {
        // Single edge-to-edge Discover tab pill row right under the contextual header
        item(key = "discover-tabs") {
            LazyRow(
                modifier = Modifier.fillMaxWidth().padding(top = 2.dp),
                contentPadding = PaddingValues(horizontal = 20.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                items(DiscoverTab.entries, key = { "dtab-${it.name}" }) { tab ->
                    val selected = discoverTab == tab
                    Box(
                        modifier = Modifier
                            .clip(PillShape)
                            .background(if (selected) Pearl else GlassBg)
                            .then(
                                if (selected) Modifier else Modifier.border(0.75.dp, GlassBorder, PillShape),
                            )
                            .clickable { model.setDiscoverTab(tab) }
                            .padding(horizontal = 13.dp, vertical = 7.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            text = tab.label,
                            color = if (selected) PearlInk else Dim,
                            fontSize = 13.sp,
                            fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Medium,
                            maxLines = 1,
                        )
                    }
                }
            }
        }

        // Dedicated Music Discovery Room (NO duplicate search box, edge-to-edge Mood pills -> Artists -> Songs)
        if (discoverTab == DiscoverTab.Music) {
            item(key = "music-discover-moods") {
                LazyRow(
                    modifier = Modifier.fillMaxWidth(),
                    contentPadding = PaddingValues(horizontal = 20.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    if (artistNames.isNotEmpty()) {
                        item(key = "mood-library") {
                            val sel = musicMood == "library" && musicQuery.isBlank()
                            MoodPill(
                                label = "For You",
                                selected = sel,
                                onClick = {
                                    model.selectedSuggestedArtist.value = null
                                    model.loadMusicDiscover(mood = "library", query = "")
                                },
                            )
                        }
                    }
                    items(MUSIC_MOODS, key = { "mood-${it.id}" }) { mood ->
                        val sel = musicMood == mood.id && musicQuery.isBlank()
                        MoodPill(
                            label = mood.label,
                            selected = sel,
                            onClick = {
                                model.selectedSuggestedArtist.value = null
                                model.loadMusicDiscover(mood = mood.id, query = "")
                            },
                        )
                    }
                }
            }

            selectedArtist?.let { artist ->
                item(key = "music-artist-spotlight") {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 20.dp)
                            .clip(PanelShape)
                            .background(GlassBg)
                            .border(0.75.dp, Brand.copy(alpha = 0.45f), PanelShape)
                            .padding(14.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        ExternalAvatar(
                            url = artist.artUrl,
                            name = artist.name,
                            modifier = Modifier.size(54.dp),
                        )
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            Text(
                                text = artist.name,
                                color = Ink,
                                fontSize = 16.sp,
                                fontWeight = FontWeight.Bold,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                            Text(
                                text = artist.genre,
                                color = Dim,
                                fontSize = 12.sp,
                                maxLines = 1,
                            )
                            Row(
                                modifier = Modifier.padding(top = 6.dp),
                                horizontalArrangement = Arrangement.spacedBy(8.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                HeroPrimaryButton(
                                    text = "Find Lossless",
                                    icon = SearchIcon,
                                    shape = PillShape,
                                    onClick = { model.openSearchFor(artist.name, askRelays = true) },
                                )
                                TextButton(
                                    onClick = { model.clearSuggestedArtist() },
                                ) {
                                    Text("Back", color = Dim, fontSize = 13.sp)
                                }
                            }
                        }
                    }
                }
            }

            if (!musicError.isNullOrBlank()) {
                item(key = "music-discover-error") {
                    Text(
                        text = musicError ?: "",
                        color = Danger,
                        fontSize = 13.sp,
                        modifier = Modifier.padding(horizontal = 20.dp),
                    )
                }
            }

            if (musicLoading && musicData == null) {
                item(key = "music-discover-loading") {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 20.dp, vertical = 12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        CircularProgressIndicator(color = Brand, strokeWidth = 2.dp, modifier = Modifier.size(18.dp))
                        Text("Curating music picks…", color = Dim, fontSize = 13.sp)
                    }
                }
            }

            val data = musicData
            if (data != null) {
                if (data.artists.isNotEmpty() && selectedArtist == null) {
                    item(key = "music-suggested-artists") {
                        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                            Row(
                                modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Text(
                                    text = "Suggested Artists",
                                    color = Ink,
                                    fontSize = 18.sp,
                                    fontWeight = FontWeight.SemiBold,
                                    letterSpacing = (-0.2).sp,
                                    modifier = Modifier.weight(1f),
                                )
                                if (musicLoading) {
                                    CircularProgressIndicator(color = Brand, strokeWidth = 2.dp, modifier = Modifier.size(15.dp))
                                }
                            }
                            LazyRow(
                                modifier = Modifier.fillMaxWidth(),
                                contentPadding = PaddingValues(horizontal = 20.dp),
                                horizontalArrangement = Arrangement.spacedBy(16.dp),
                            ) {
                                items(data.artists, key = { "sart-${it.name}" }) { artist ->
                                    SuggestedArtistCard(
                                        artist = artist,
                                        onClick = { model.openExternalArtist(name = artist.name, artUrl = artist.artUrl) },
                                    )
                                }
                            }
                        }
                    }
                }

                if (data.songs.isNotEmpty()) {
                    item(key = "music-suggested-songs") {
                        Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp)) {
                            Row(
                                modifier = Modifier.fillMaxWidth().padding(bottom = 8.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Text(
                                    text = selectedArtist?.let { "Top Tracks · ${it.name}" } ?: "Suggested Songs",
                                    color = Ink,
                                    fontSize = 18.sp,
                                    fontWeight = FontWeight.SemiBold,
                                    letterSpacing = (-0.2).sp,
                                    modifier = Modifier.weight(1f),
                                )
                                Text("Tap to stream", color = Dim, fontSize = 11.sp)
                            }
                            data.songs.forEachIndexed { idx, song ->
                                if (idx > 0) {
                                    HorizontalDivider(color = Line.copy(alpha = 0.32f))
                                }
                                SuggestedSongRow(
                                    song = song,
                                    musicState = musicState,
                                    onToggleStream = {
                                        model.streamFullSong(
                                            id = "song:${song.id}",
                                            title = song.title,
                                            artist = song.artist,
                                            album = song.album,
                                            artUrl = song.artUrl,
                                            sourceLabel = "Streaming",
                                        )
                                    },
                                    onGet = { model.openSearchFor("${song.artist} ${song.title}", askRelays = true) },
                                )
                            }
                        }
                    }
                }

                if (data.albums.isNotEmpty()) {
                    item(key = "music-suggested-albums") {
                        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                            Text(
                                text = "Recommended Albums",
                                color = Ink,
                                fontSize = 18.sp,
                                fontWeight = FontWeight.SemiBold,
                                letterSpacing = (-0.2).sp,
                                modifier = Modifier.padding(horizontal = 20.dp),
                            )
                            LazyRow(
                                modifier = Modifier.fillMaxWidth(),
                                contentPadding = PaddingValues(horizontal = 20.dp),
                                horizontalArrangement = Arrangement.spacedBy(14.dp),
                            ) {
                                items(data.albums, key = { "salb-${it.artist}-${it.title}" }) { album ->
                                    SuggestedAlbumCard(
                                        album = album,
                                        onClick = {
                                            model.openExternalAlbum(
                                                title = album.title,
                                                artist = album.artist,
                                                artUrl = album.artUrl,
                                            )
                                        },
                                        onLongClick = {
                                            haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                                            model.openPeek(PeekTarget.DiscoverAlbum(album))
                                        },
                                    )
                                }
                            }
                        }
                    }
                }
            }
            return@LazyColumn
        }

        // Movies & TV Tab: Live Cinemeta Discovery Room
        if (discoverTab == DiscoverTab.Cinema) {
            item(key = "cinema-genres") {
                LazyRow(
                    modifier = Modifier.fillMaxWidth(),
                    contentPadding = PaddingValues(horizontal = 20.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    items(CINEMA_GENRES, key = { "cgenre-$it" }) { genre ->
                        MoodPill(
                            label = genre,
                            selected = cinemaGenre.equals(genre, ignoreCase = true),
                            onClick = { model.loadCinemaDiscover(genre) },
                        )
                    }
                }
            }

            if (!cinemaError.isNullOrBlank()) {
                item(key = "cinema-error") {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 20.dp)
                            .clip(CardShape)
                            .background(Danger.copy(alpha = 0.14f))
                            .border(0.75.dp, Danger.copy(alpha = 0.4f), CardShape)
                            .padding(horizontal = 12.dp, vertical = 10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        Text(
                            text = cinemaError ?: "",
                            color = Ink,
                            fontSize = 13.sp,
                            modifier = Modifier.weight(1f),
                        )
                        TextButton(onClick = { model.loadCinemaDiscover(cinemaGenre) }) {
                            Text("Retry", color = Pearl, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                        }
                    }
                }
            }

            if (cinemaLoading && cinemaData == null) {
                item(key = "cinema-loading") {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 20.dp, vertical = 14.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        CircularProgressIndicator(color = Brand, strokeWidth = 2.dp, modifier = Modifier.size(18.dp))
                        Text("Loading $cinemaGenre picks…", color = Dim, fontSize = 13.sp)
                    }
                }
            }

            val cData = cinemaData
            if (cData != null) {
                val isPopular = cinemaGenre.equals("Popular", ignoreCase = true)
                val moviesHeading = if (isPopular) "Trending Movies" else "$cinemaGenre Movies"
                val seriesHeading = if (isPopular) "Popular TV Shows" else "$cinemaGenre TV Shows"

                if (cData.movies.isNotEmpty()) {
                    item(key = "cinema-movies-shelf") {
                        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                            Row(
                                modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Text(
                                    text = moviesHeading,
                                    color = Ink,
                                    fontSize = 18.sp,
                                    fontWeight = FontWeight.SemiBold,
                                    letterSpacing = (-0.2).sp,
                                    modifier = Modifier.weight(1f),
                                )
                                if (cinemaLoading) {
                                    CircularProgressIndicator(color = Brand, strokeWidth = 2.dp, modifier = Modifier.size(15.dp))
                                }
                            }
                            LazyRow(
                                modifier = Modifier.fillMaxWidth(),
                                contentPadding = PaddingValues(horizontal = 20.dp),
                                horizontalArrangement = Arrangement.spacedBy(12.dp),
                            ) {
                                items(cData.movies.take(12), key = { "cm-${it.imdbId}" }) { item ->
                                    DiscoverCinemaPosterCard(
                                        item = item,
                                        inLibrary = item.imdbId in libraryTilesByImdb,
                                        showRatingBadge = false,
                                        showInlineRating = true,
                                        onClick = { selectedCinemaItem = item },
                                        onLongClick = {
                                            haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                                            model.openPeek(PeekTarget.DiscoverCinema(item))
                                        },
                                        modifier = Modifier.width(122.dp),
                                    )
                                }
                            }
                        }
                    }
                }

                if (cData.series.isNotEmpty()) {
                    item(key = "cinema-series-shelf") {
                        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                            SectionHeader(title = seriesHeading)
                            LazyRow(
                                modifier = Modifier.fillMaxWidth(),
                                contentPadding = PaddingValues(horizontal = 20.dp),
                                horizontalArrangement = Arrangement.spacedBy(12.dp),
                            ) {
                                items(cData.series.take(12), key = { "cs-${it.imdbId}" }) { item ->
                                    DiscoverCinemaPosterCard(
                                        item = item,
                                        inLibrary = item.imdbId in libraryTilesByImdb,
                                        showRatingBadge = false,
                                        showInlineRating = true,
                                        onClick = { selectedCinemaItem = item },
                                        onLongClick = {
                                            haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                                            model.openPeek(PeekTarget.DiscoverCinema(item))
                                        },
                                        modifier = Modifier.width(122.dp),
                                    )
                                }
                            }
                        }
                    }
                }

                if (cinemaMoreItems.isNotEmpty()) {
                    item(key = "cinema-more-head") {
                        SectionHeader(title = "More to Explore")
                    }
                    val moreRows = cinemaMoreItems.chunked(3)
                    items(moreRows.size, key = { idx -> "cinema-more-row-$idx" }) { rowIdx ->
                        val rowItems = moreRows[rowIdx]
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(horizontal = 20.dp),
                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            rowItems.forEach { item ->
                                DiscoverCinemaPosterCard(
                                    item = item,
                                    inLibrary = item.imdbId in libraryTilesByImdb,
                                    showRatingBadge = false,
                                    showInlineRating = true,
                                    onClick = { selectedCinemaItem = item },
                                    onLongClick = {
                                        haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                                        model.openPeek(PeekTarget.DiscoverCinema(item))
                                    },
                                    modifier = Modifier.weight(1f),
                                )
                            }
                            repeat(3 - rowItems.size) {
                                Spacer(Modifier.weight(1f))
                            }
                        }
                    }
                }
            }

            item(key = "cinema-network") {
                NetworkChannelsSection(
                    discovered = discovered,
                    onFollow = { model.subscribeDiscovered(it) },
                    modifier = Modifier.padding(horizontal = 20.dp),
                )
            }
            return@LazyColumn
        }

        // Everything (All) Tab: Flagship Editorial Hub (ZERO empty dead boxes!)
        if (discoverTab == DiscoverTab.All) {
            // Section 1: Featured Cinema Spotlight
            if (spotlightCinema != null) {
                item(key = "discover-all-spotlight") {
                    CinemaSpotlightCard(
                        item = spotlightCinema,
                        onClick = { selectedCinemaItem = spotlightCinema },
                        modifier = Modifier.padding(horizontal = 20.dp),
                    )
                }
            } else if (cinemaLoading) {
                item(key = "discover-all-cinema-loading") {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 20.dp, vertical = 6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        CircularProgressIndicator(color = Brand, strokeWidth = 2.dp, modifier = Modifier.size(16.dp))
                        Text("Loading trending movies & shows…", color = Dim, fontSize = 13.sp)
                    }
                }
            }

            // Section 2: Trending Movies & TV
            if (interleavedTrending.isNotEmpty()) {
                item(key = "discover-all-trending-cinema") {
                    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        SectionHeader(
                            title = "Trending Movies & TV",
                            actionLabel = "Movies & TV →",
                            onAction = { model.setDiscoverTab(DiscoverTab.Cinema) },
                        )
                        LazyRow(
                            modifier = Modifier.fillMaxWidth(),
                            contentPadding = PaddingValues(horizontal = 20.dp),
                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            items(interleavedTrending, key = { "all-cin-${it.imdbId}" }) { item ->
                                DiscoverCinemaPosterCard(
                                    item = item,
                                    inLibrary = item.imdbId in libraryTilesByImdb,
                                    showRatingBadge = false,
                                    showInlineRating = true,
                                    onClick = { selectedCinemaItem = item },
                                    onLongClick = {
                                        haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                                        model.openPeek(PeekTarget.DiscoverCinema(item))
                                    },
                                    modifier = Modifier.width(122.dp),
                                )
                            }
                        }
                    }
                }
            }

            // Section 3: Suggested Artists
            val stripArtists = musicData?.artists.orEmpty()
            if (stripArtists.isNotEmpty()) {
                item(key = "discover-all-music-strip") {
                    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        SectionHeader(
                            title = "Suggested Artists",
                            actionLabel = "Music →",
                            onAction = { model.setDiscoverTab(DiscoverTab.Music) },
                        )
                        LazyRow(
                            modifier = Modifier.fillMaxWidth(),
                            contentPadding = PaddingValues(horizontal = 20.dp),
                            horizontalArrangement = Arrangement.spacedBy(16.dp),
                        ) {
                            items(stripArtists.take(8), key = { "all-art-${it.name}" }) { artist ->
                                SuggestedArtistCard(
                                    artist = artist,
                                    onClick = {
                                        model.openExternalArtist(name = artist.name, artUrl = artist.artUrl)
                                    },
                                )
                            }
                        }
                    }
                }
            }

            // Section 4: Creators & Topics (Following chips + latest 4 OR Creators to Follow strip — never empty!)
            if (creators.isNotEmpty()) {
                item(key = "discover-all-following") {
                    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        SectionHeader(
                            title = "Following",
                            actionLabel = "Manage",
                            onAction = { showManageFollowing = true },
                        )
                        LazyRow(
                            modifier = Modifier.fillMaxWidth(),
                            contentPadding = PaddingValues(horizontal = 20.dp),
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            item(key = "all-creator-all") {
                                val selected = !browsing && creatorFilter.isEmpty()
                                MoodPill(
                                    label = "All",
                                    selected = selected,
                                    onClick = { model.setDiscoverCreatorFilter("") },
                                )
                            }
                            items(creators, key = { "all-creator-${it.id}" }) { creator ->
                                val selected = !browsing && creatorFilter == creator.id
                                DiscoverCreatorChip(
                                    creator = creator,
                                    apiUrl = apiUrl,
                                    selected = selected,
                                    onSelect = { model.setDiscoverCreatorFilter(creator.id) },
                                    onUnfollow = { model.unfollowDiscoverCreator(creator.id) },
                                )
                            }
                        }
                    }
                }
            } else if (unfollowedFeaturedCreators.isNotEmpty()) {
                item(key = "discover-all-featured-creators") {
                    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        SectionHeader(
                            title = "Creators to Follow",
                            actionLabel = "Videos →",
                            onAction = { model.setDiscoverTab(DiscoverTab.Videos) },
                        )
                        LazyRow(
                            modifier = Modifier.fillMaxWidth(),
                            contentPadding = PaddingValues(horizontal = 20.dp),
                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            items(unfollowedFeaturedCreators, key = { "all-fc-${it.id}" }) { creator ->
                                FeaturedCreatorCard(
                                    creator = creator,
                                    busy = followBusy,
                                    onFollow = {
                                        model.followDiscoverCreator(
                                            input = creator.url,
                                            name = creator.name,
                                            source = creator.source,
                                            handle = creator.handle,
                                        )
                                    },
                                )
                            }
                        }
                    }
                }
            }

            // Edge-to-edge Browse topics pills
            item(key = "discover-all-topics") {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text(
                        text = "Browse topics",
                        color = Dim,
                        fontSize = 13.sp,
                        fontWeight = FontWeight.SemiBold,
                        modifier = Modifier.padding(horizontal = 20.dp),
                    )
                    LazyRow(
                        modifier = Modifier.fillMaxWidth(),
                        contentPadding = PaddingValues(horizontal = 20.dp),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        items(DISCOVER_TOPICS, key = { "all-topic-$it" }) { topic ->
                            val selected = activeTopic.equals(topic, ignoreCase = true)
                            MoodPill(
                                label = topic,
                                selected = selected,
                                onClick = {
                                    if (selected) model.clearDiscoverBrowse()
                                    else model.browseDiscoverTopic(topic)
                                },
                            )
                        }
                    }
                }
            }

            if (browsing || (creators.isNotEmpty() && shownItems.isNotEmpty())) {
                item(key = "discover-all-feed-head") {
                    Row(
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Text(
                            text = if (browsing) "${activeTopic ?: ""} Videos" else "Latest from creators",
                            color = Ink,
                            fontSize = 18.sp,
                            fontWeight = FontWeight.SemiBold,
                            letterSpacing = (-0.2).sp,
                            modifier = Modifier.weight(1f),
                        )
                        if (loading || (browsing && shownItems.isEmpty() && externalVideosLoading)) {
                            CircularProgressIndicator(color = Brand, strokeWidth = 2.dp, modifier = Modifier.size(16.dp))
                        }
                        if (browsing) {
                            TextButton(
                                onClick = { model.clearDiscoverBrowse() },
                                contentPadding = PaddingValues(horizontal = 6.dp, vertical = 2.dp),
                            ) {
                                Text("Clear", color = Dim, fontSize = 13.sp, fontWeight = FontWeight.Medium)
                            }
                        } else if (shownItems.size > 4) {
                            TextButton(
                                onClick = { model.setDiscoverTab(DiscoverTab.Videos) },
                                contentPadding = PaddingValues(horizontal = 6.dp, vertical = 2.dp),
                            ) {
                                Text("Videos →", color = Dim, fontSize = 13.sp, fontWeight = FontWeight.Medium)
                            }
                        }
                    }
                }

                if (shownItems.isNotEmpty()) {
                    val previewItems = if (browsing) shownItems.take(8) else shownItems.take(4)
                    items(previewItems, key = { "all-di-${it.id}" }) { item ->
                        val inLibrary = item.inLibrary ||
                            (item.acquireId.isNotBlank() && item.acquireId.lowercase(Locale.ROOT) in libraryIds)
                        val isAdding = item.id in submittingIds ||
                            (item.acquireId.isNotBlank() && item.acquireId.lowercase(Locale.ROOT) in activeAcquireIds)
                        val creatorAlreadyFollowed = item.creatorId in followedCreatorIds ||
                            (item.creatorUrl.isNotBlank() && item.creatorUrl.lowercase(Locale.ROOT) in followedCreatorUrls) ||
                            "${item.source}:${item.creatorName.lowercase(Locale.ROOT)}" in followedCreatorKeys
                        DiscoverItemCard(
                            item = item,
                            apiUrl = apiUrl,
                            inLibrary = inLibrary,
                            isAdding = isAdding,
                            showFollowCreator = browsing && item.creatorUrl.isNotBlank() && !creatorAlreadyFollowed,
                            followBusy = followBusy,
                            onAdd = { model.addDiscoverItemToLibrary(item) },
                            onAddAudio = { model.addDiscoverItemToLibrary(item, audioOverride = true) },
                            onFollowCreator = {
                                model.followDiscoverCreator(
                                    input = item.creatorUrl,
                                    name = item.creatorName,
                                )
                            },
                            modifier = Modifier.padding(horizontal = 20.dp),
                        )
                    }
                } else if (browsing && externalVideos.isNotEmpty()) {
                    items(externalVideos.take(6), key = { "all-extvid-${it.videoId}" }) { video ->
                        val acquireKey = "yt:${video.videoId}".lowercase(Locale.ROOT)
                        ExternalVideoCard(
                            video = video,
                            inLibrary = acquireKey in libraryIds,
                            isAdding = "yt:${video.videoId}" in submittingIds || acquireKey in activeAcquireIds,
                            onAdd = { model.addExternalVideoToLibrary(video, audioOnly = false) },
                            onAddAudio = { model.addExternalVideoToLibrary(video, audioOnly = true) },
                            onLongClick = {
                                haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                                model.openPeek(PeekTarget.DiscoverVideo(video))
                            },
                            modifier = Modifier.padding(horizontal = 20.dp),
                        )
                    }
                }
            }

            if (visitedShelves.isNotEmpty()) {
                item(key = "discover-shelves") {
                    Column(
                        modifier = Modifier.padding(horizontal = 20.dp),
                        verticalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        HorizontalDivider(color = Line.copy(alpha = 0.35f))
                        Spacer(Modifier.height(6.dp))
                        Text("Shelves you visited", color = Ink, fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
                        visitedShelves.forEachIndexed { idx, shelf ->
                            if (idx > 0) HorizontalDivider(color = Line.copy(alpha = 0.3f))
                            Row(
                                Modifier
                                    .fillMaxWidth()
                                    .clickable { model.openShelf(shelf.peer) }
                                    .padding(vertical = 12.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                    Text(shelf.peer, color = Ink, fontSize = 15.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                    val sub = if (shelf.folderCount > 0) {
                                        "Soulseek · ${plural(shelf.folderCount, "folder", "folders")}"
                                    } else {
                                        "Soulseek shelf"
                                    }
                                    Text(sub, color = Dim, fontSize = 12.sp)
                                }
                                Icon(ChevronRightIcon, null, tint = Dim, modifier = Modifier.size(18.dp))
                            }
                        }
                    }
                }
            }

            item(key = "discover-all-network") {
                NetworkChannelsSection(
                    discovered = discovered,
                    onFollow = { model.subscribeDiscovered(it) },
                    modifier = Modifier.padding(horizontal = 20.dp),
                )
            }
            return@LazyColumn
        }

        // Videos Tab: Live Creators & Video Feed + Featured Creators strip + Browse topics
        if (creators.isNotEmpty()) {
            item(key = "discover-creators-row") {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Row(
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            text = "Following",
                            color = Ink,
                            fontSize = 18.sp,
                            fontWeight = FontWeight.SemiBold,
                            modifier = Modifier.weight(1f),
                        )
                        TextButton(
                            onClick = { showManageFollowing = true },
                            contentPadding = PaddingValues(horizontal = 8.dp, vertical = 2.dp),
                        ) {
                            Text("Manage", color = BrandHover, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                        }
                        TextButton(
                            enabled = !loading,
                            onClick = {
                                if (browsing && activeTopic != null) {
                                    model.browseDiscoverTopic(activeTopic ?: return@TextButton)
                                } else {
                                    model.loadDiscoverFeed(refresh = true)
                                }
                            },
                            contentPadding = PaddingValues(horizontal = 6.dp, vertical = 2.dp),
                        ) {
                            Icon(ReplayIcon, null, tint = Dim, modifier = Modifier.size(15.dp))
                            Spacer(Modifier.width(4.dp))
                            Text("Refresh", color = Dim, fontSize = 12.sp, fontWeight = FontWeight.Medium)
                        }
                    }
                    LazyRow(
                        modifier = Modifier.fillMaxWidth(),
                        contentPadding = PaddingValues(horizontal = 20.dp),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        item(key = "creator-all") {
                            val selected = !browsing && creatorFilter.isEmpty()
                            MoodPill(
                                label = "All",
                                selected = selected,
                                onClick = { model.setDiscoverCreatorFilter("") },
                            )
                        }
                        items(creators, key = { "creator-${it.id}" }) { creator ->
                            val selected = !browsing && creatorFilter == creator.id
                            DiscoverCreatorChip(
                                creator = creator,
                                apiUrl = apiUrl,
                                selected = selected,
                                onSelect = { model.setDiscoverCreatorFilter(creator.id) },
                                onUnfollow = { model.unfollowDiscoverCreator(creator.id) },
                            )
                        }
                    }
                }
            }
        }

        // Featured Creators strip (filtering out already-followed ones, always giving 1-tap Follow)
        if (unfollowedFeaturedCreators.isNotEmpty()) {
            item(key = "discover-featured-creators") {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    SectionHeader(title = "Featured Creators")
                    LazyRow(
                        modifier = Modifier.fillMaxWidth(),
                        contentPadding = PaddingValues(horizontal = 20.dp),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        items(unfollowedFeaturedCreators, key = { "vid-fc-${it.id}" }) { creator ->
                            FeaturedCreatorCard(
                                creator = creator,
                                busy = followBusy,
                                onFollow = {
                                    model.followDiscoverCreator(
                                        input = creator.url,
                                        name = creator.name,
                                        source = creator.source,
                                        handle = creator.handle,
                                    )
                                },
                            )
                        }
                    }
                }
            }
        }

        // Labeled edge-to-edge topic browse pills
        item(key = "discover-topics") {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(
                    text = "Browse topics",
                    color = Dim,
                    fontSize = 13.sp,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.padding(horizontal = 20.dp),
                )
                LazyRow(
                    modifier = Modifier.fillMaxWidth(),
                    contentPadding = PaddingValues(horizontal = 20.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    items(DISCOVER_TOPICS, key = { "topic-$it" }) { topic ->
                        val selected = activeTopic.equals(topic, ignoreCase = true)
                        MoodPill(
                            label = topic,
                            selected = selected,
                            onClick = {
                                if (selected) model.clearDiscoverBrowse()
                                else model.browseDiscoverTopic(topic)
                            },
                        )
                    }
                }
            }
        }

        // Show source filter pills only when actively filtering or browsing multiple sources
        if (browsing || creators.size > 1 || sourceFilter.isNotEmpty()) {
            item(key = "discover-source-filter") {
                LazyRow(
                    modifier = Modifier.fillMaxWidth(),
                    contentPadding = PaddingValues(horizontal = 20.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    items(DISCOVER_SOURCE_FILTERS, key = { "src-${it.first}" }) { (id, label) ->
                        val selected = sourceFilter == id
                        MoodPill(
                            label = label,
                            selected = selected,
                            onClick = { model.setDiscoverSourceFilter(id) },
                        )
                    }
                }
            }
        }

        if (!discoverError.isNullOrBlank()) {
            item(key = "discover-error-banner") {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 20.dp)
                        .clip(CardShape)
                        .background(Danger.copy(alpha = 0.14f))
                        .border(0.75.dp, Danger.copy(alpha = 0.4f), CardShape)
                        .padding(start = 12.dp, end = 4.dp, top = 6.dp, bottom = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        text = discoverError ?: "",
                        color = Ink,
                        fontSize = 13.sp,
                        modifier = Modifier.weight(1f),
                    )
                    CinemaIcon(CloseIcon, "Dismiss", Ink) { model.discoverError.value = null }
                }
            }
        }

        if (shownErrors.isNotEmpty()) {
            item(key = "discover-partial-errors") {
                DiscoverSoftErrorBanner(
                    errors = shownErrors,
                    modifier = Modifier.padding(horizontal = 20.dp),
                )
            }
        }

        val showLocalFeed = shownItems.isNotEmpty() || (loading && (browsing || creators.isNotEmpty()) && externalVideos.isEmpty())
        if (showLocalFeed) {
            item(key = "discover-feed-head") {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    val heading = if (browsing) {
                        "${activeTopic ?: ""} Videos"
                    } else {
                        "Latest from creators"
                    }
                    Text(
                        text = heading,
                        color = Ink,
                        fontSize = 18.sp,
                        fontWeight = FontWeight.SemiBold,
                        letterSpacing = (-0.2).sp,
                        modifier = Modifier.weight(1f),
                    )
                    if (loading) {
                        CircularProgressIndicator(
                            color = Brand,
                            strokeWidth = 2.dp,
                            modifier = Modifier.size(16.dp),
                        )
                    }
                    if (browsing) {
                        TextButton(
                            onClick = { model.clearDiscoverBrowse() },
                            contentPadding = PaddingValues(horizontal = 6.dp, vertical = 2.dp),
                        ) {
                            Text("Clear", color = Dim, fontSize = 13.sp, fontWeight = FontWeight.Medium)
                        }
                    }
                }
            }

            if (browsing) {
                val browseCreators = browse?.creators.orEmpty().filter {
                    sourceFilter.isEmpty() || it.source == sourceFilter
                }
                if (browseCreators.isNotEmpty()) {
                    item(key = "discover-browse-creators") {
                        LazyRow(
                            modifier = Modifier.fillMaxWidth(),
                            contentPadding = PaddingValues(horizontal = 20.dp),
                            horizontalArrangement = Arrangement.spacedBy(10.dp),
                        ) {
                            items(browseCreators, key = { "bc-${it.id}-${it.url}" }) { bc ->
                                val matchedFollowed = findFollowedCreator(
                                    creators = creators,
                                    id = bc.id,
                                    url = bc.url,
                                    handle = bc.handle,
                                    source = bc.source,
                                    name = bc.displayName,
                                )
                                val alreadyFollowed = bc.followed || matchedFollowed != null
                                DiscoverBrowseCreatorCard(
                                    creator = bc,
                                    apiUrl = apiUrl,
                                    followed = alreadyFollowed,
                                    followBusy = followBusy,
                                    onFollow = {
                                        model.followDiscoverCreator(
                                            input = bc.url,
                                            name = bc.displayName,
                                        )
                                    },
                                    onUnfollow = matchedFollowed?.let { f -> { model.unfollowDiscoverCreator(f.id) } },
                                )
                            }
                        }
                    }
                }
            }

            if (loading && shownItems.isEmpty()) {
                item(key = "discover-loading") {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 20.dp, vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        CircularProgressIndicator(color = Brand, strokeWidth = 2.dp, modifier = Modifier.size(18.dp))
                        Text(
                            text = if (browsing) "Browsing \"${activeTopic ?: ""}\"…" else "Refreshing your feed…",
                            color = Dim,
                            fontSize = 13.sp,
                        )
                    }
                }
            } else {
                items(shownItems, key = { "di-${it.id}" }) { item ->
                    val inLibrary = item.inLibrary ||
                        (item.acquireId.isNotBlank() && item.acquireId.lowercase(Locale.ROOT) in libraryIds)
                    val isAdding = item.id in submittingIds ||
                        (item.acquireId.isNotBlank() && item.acquireId.lowercase(Locale.ROOT) in activeAcquireIds)
                    val creatorAlreadyFollowed = item.creatorId in followedCreatorIds ||
                        (item.creatorUrl.isNotBlank() && item.creatorUrl.lowercase(Locale.ROOT) in followedCreatorUrls) ||
                        "${item.source}:${item.creatorName.lowercase(Locale.ROOT)}" in followedCreatorKeys
                    DiscoverItemCard(
                        item = item,
                        apiUrl = apiUrl,
                        inLibrary = inLibrary,
                        isAdding = isAdding,
                        showFollowCreator = browsing && item.creatorUrl.isNotBlank() && !creatorAlreadyFollowed,
                        followBusy = followBusy,
                        onAdd = { model.addDiscoverItemToLibrary(item) },
                        onAddAudio = { model.addDiscoverItemToLibrary(item, audioOverride = true) },
                        onFollowCreator = {
                            model.followDiscoverCreator(
                                input = item.creatorUrl,
                                name = item.creatorName,
                            )
                        },
                        modifier = Modifier.padding(horizontal = 20.dp),
                    )
                }
            }
        } else {
            // Live Recommended Videos (or "$activeTopic Videos") whenever local creator feed/browse results are empty
            item(key = "discover-external-videos-head") {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Text(
                        text = activeTopic?.takeIf { it.isNotBlank() }?.let { "$it Videos" } ?: "Recommended Videos",
                        color = Ink,
                        fontSize = 18.sp,
                        fontWeight = FontWeight.SemiBold,
                        letterSpacing = (-0.2).sp,
                        modifier = Modifier.weight(1f),
                    )
                    if (externalVideosLoading) {
                        CircularProgressIndicator(
                            color = Brand,
                            strokeWidth = 2.dp,
                            modifier = Modifier.size(16.dp),
                        )
                    }
                    if (browsing) {
                        TextButton(
                            onClick = { model.clearDiscoverBrowse() },
                            contentPadding = PaddingValues(horizontal = 6.dp, vertical = 2.dp),
                        ) {
                            Text("Clear", color = Dim, fontSize = 13.sp, fontWeight = FontWeight.Medium)
                        }
                    }
                }
            }

            if (externalVideosLoading && externalVideos.isEmpty()) {
                item(key = "discover-external-videos-loading") {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 20.dp, vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        CircularProgressIndicator(color = Brand, strokeWidth = 2.dp, modifier = Modifier.size(18.dp))
                        Text(
                            text = activeTopic?.let { "Finding $it videos…" } ?: "Finding recommended videos…",
                            color = Dim,
                            fontSize = 13.sp,
                        )
                    }
                }
            } else if (externalVideos.isNotEmpty()) {
                items(externalVideos, key = { "extvid-${it.videoId}" }) { video ->
                    val acquireKey = "yt:${video.videoId}".lowercase(Locale.ROOT)
                    ExternalVideoCard(
                        video = video,
                        inLibrary = acquireKey in libraryIds,
                        isAdding = "yt:${video.videoId}" in submittingIds || acquireKey in activeAcquireIds,
                        onAdd = { model.addExternalVideoToLibrary(video, audioOnly = false) },
                        onAddAudio = { model.addExternalVideoToLibrary(video, audioOnly = true) },
                        onLongClick = {
                            haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                            model.openPeek(PeekTarget.DiscoverVideo(video))
                        },
                        modifier = Modifier.padding(horizontal = 20.dp),
                    )
                }
            } else if (browsing || creators.isNotEmpty()) {
                item(key = "discover-empty-items") {
                    Text(
                        text = if (browsing) "No results for \"${activeTopic ?: ""}\"." else "No recent items match this filter.",
                        color = Dim,
                        fontSize = 13.sp,
                        modifier = Modifier.padding(horizontal = 20.dp, vertical = 6.dp),
                    )
                }
            }
        }

        item(key = "discover-network") {
            NetworkChannelsSection(
                discovered = discovered,
                onFollow = { model.subscribeDiscovered(it) },
                modifier = Modifier.padding(horizontal = 20.dp),
            )
        }
    }

    selectedCinemaItem?.let { item ->
        DiscoverCinemaSheet(
            item = item,
            inLibraryTile = libraryTilesByImdb[item.imdbId],
            onDismiss = { selectedCinemaItem = null },
            onOpenInLibrary = { tile ->
                selectedCinemaItem = null
                onOpenTitle(tile.key)
            },
            onFindOnPearTube = {
                selectedCinemaItem = null
                model.openSearchFor(item.title, askRelays = true)
            },
            onSelectGenre = { genre ->
                selectedCinemaItem = null
                model.setDiscoverTab(DiscoverTab.Cinema)
                model.loadCinemaDiscover(genre)
            },
            onSearchCast = { actor ->
                selectedCinemaItem = null
                model.openSearchFor(actor, askRelays = true)
            },
        )
    }

    if (showManageFollowing) {
        if (creators.isEmpty()) {
            showManageFollowing = false
        } else {
            ManageFollowingSheet(
                creators = creators,
                apiUrl = apiUrl,
                onDismiss = { showManageFollowing = false },
                onUnfollow = { creator -> model.unfollowDiscoverCreator(creator.id) },
            )
        }
    }
}

@Composable
private fun CinemaSpotlightCard(
    item: CinemaDiscoverItem,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val backdropUrl = item.backdropUrl.ifBlank { imdbBackdropUrl(item.imdbId).orEmpty() }
    val posterUrl = item.posterUrl.ifBlank { imdbPosterUrl(item.imdbId).orEmpty() }
    val bitmap by produceState<ImageBitmap?>(
        initialValue = backdropUrl.takeIf { it.isNotBlank() }?.let { ExternalImageCache.get(it) }
            ?: posterUrl.takeIf { it.isNotBlank() }?.let { ExternalImageCache.get(it) },
        key1 = backdropUrl,
        key2 = posterUrl,
    ) {
        value = when {
            backdropUrl.isNotBlank() -> ExternalImageCache.load(backdropUrl)
                ?: posterUrl.takeIf { it.isNotBlank() }?.let { ExternalImageCache.load(it) }
            posterUrl.isNotBlank() -> ExternalImageCache.load(posterUrl)
            else -> null
        }
    }

    Box(
        modifier = modifier
            .fillMaxWidth()
            .height(196.dp)
            .clip(HeroShape)
            .background(CardElevated)
            .border(0.75.dp, GlassBorder, HeroShape)
            .clickable(onClick = onClick),
    ) {
        val art = bitmap
        if (art != null) {
            Image(
                bitmap = art,
                contentDescription = item.title,
                contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxSize(),
            )
        }
        Canvas(Modifier.fillMaxSize()) {
            drawRect(
                Brush.verticalGradient(
                    0.0f to Bg.copy(alpha = 0.14f),
                    0.45f to Bg.copy(alpha = 0.42f),
                    1.0f to Bg.copy(alpha = 0.90f),
                ),
            )
        }

        Column(
            modifier = Modifier
                .align(Alignment.BottomStart)
                .fillMaxWidth()
                .padding(horizontal = 18.dp, vertical = 16.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Text(
                text = "TRENDING NOW",
                color = Pearl.copy(alpha = 0.80f),
                fontSize = 10.5.sp,
                fontWeight = FontWeight.SemiBold,
                letterSpacing = 1.5.sp,
                maxLines = 1,
            )
            Text(
                text = item.title,
                color = Ink,
                fontSize = 22.sp,
                lineHeight = 25.sp,
                fontFamily = FontFamily.SansSerif,
                fontWeight = FontWeight.Bold,
                letterSpacing = (-0.5).sp,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                val lead = item.year.ifBlank { if (item.kind == "series") "TV Show" else "Movie" }
                Text(lead, color = Ink.copy(alpha = 0.82f), fontSize = 12.sp, fontWeight = FontWeight.Medium)
                if (item.rating.isNotBlank()) {
                    Text("·", color = Dim, fontSize = 12.sp)
                    Text("★ ${item.rating}", color = Warn, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                }
                val firstGenre = item.genres.firstOrNull()
                if (!firstGenre.isNullOrBlank()) {
                    Text("·", color = Dim, fontSize = 12.sp)
                    Text(
                        text = firstGenre,
                        color = Ink.copy(alpha = 0.78f),
                        fontSize = 12.sp,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun DiscoverCinemaPosterCard(
    item: CinemaDiscoverItem,
    inLibrary: Boolean,
    showRatingBadge: Boolean = true,
    showInlineRating: Boolean = false,
    onClick: () -> Unit,
    onLongClick: (() -> Unit)? = null,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier.combinedClickable(
            onClick = onClick,
            onLongClick = onLongClick,
        ),
        verticalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        Box(modifier = Modifier.fillMaxWidth()) {
            PosterArt(
                title = item.title,
                year = item.year,
                seed = sleeveHash(item.title),
                kindLabel = if (item.kind == "series") "TV Show" else "Movie",
                imdb = item.imdbId,
                posterUrlOverride = item.posterUrl.takeIf { it.isNotBlank() },
                cornerRadius = 12.dp,
                borderless = true,
                modifier = Modifier.fillMaxWidth(),
            )
            if (showRatingBadge && item.rating.isNotBlank()) {
                Box(
                    modifier = Modifier
                        .align(Alignment.TopEnd)
                        .padding(6.dp)
                        .clip(PillShape)
                        .background(Bg.copy(alpha = 0.78f))
                        .border(0.5.dp, GlassBorder, PillShape)
                        .padding(horizontal = 6.dp, vertical = 2.dp),
                ) {
                    Text(
                        text = "★ ${item.rating}",
                        color = Warn,
                        fontSize = 10.sp,
                        fontWeight = FontWeight.SemiBold,
                        maxLines = 1,
                    )
                }
            }
        }
        Text(
            text = item.title,
            color = Ink,
            fontSize = 13.sp,
            fontWeight = FontWeight.Medium,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(5.dp),
        ) {
            if (inLibrary) {
                Box(
                    modifier = Modifier
                        .size(5.dp)
                        .clip(CircleShape)
                        .background(Accent),
                )
            }
            val yearOrKind = item.year.ifBlank { if (item.kind == "series") "TV Show" else "Movie" }
            Text(
                text = yearOrKind,
                color = Dim,
                fontSize = 11.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (showInlineRating && item.rating.isNotBlank()) {
                Text(
                    text = "· ★ ${item.rating}",
                    color = Warn,
                    fontSize = 11.sp,
                    fontWeight = FontWeight.Medium,
                    maxLines = 1,
                )
            }
        }
    }
}

@Composable
private fun FeaturedCreatorCard(
    creator: CreatorSuggestion,
    busy: Boolean,
    onFollow: () -> Unit,
) {
    Column(
        modifier = Modifier
            .width(136.dp)
            .clip(CardShape)
            .background(CardBg)
            .border(0.75.dp, GlassBorder, CardShape)
            .padding(horizontal = 10.dp, vertical = 12.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        ExternalAvatar(
            url = creator.avatarUrl,
            name = creator.name,
            accent = sourceAccentColor(creator.source),
            modifier = Modifier.size(54.dp),
        )
        Text(
            text = creator.name,
            color = Ink,
            fontSize = 12.5.sp,
            fontWeight = FontWeight.SemiBold,
            textAlign = TextAlign.Center,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.fillMaxWidth(),
        )
        Text(
            text = creator.subscribers.ifBlank { creator.handle },
            color = Dim,
            fontSize = 10.5.sp,
            textAlign = TextAlign.Center,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.fillMaxWidth(),
        )
        Box(
            modifier = Modifier
                .padding(top = 2.dp)
                .clip(PillShape)
                .background(Pearl)
                .clickable(enabled = !busy, onClick = onFollow)
                .padding(horizontal = 14.dp, vertical = 5.dp),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = "Follow",
                color = PearlInk,
                fontSize = 11.5.sp,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
            )
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
private fun DiscoverCinemaSheet(
    item: CinemaDiscoverItem,
    inLibraryTile: LibraryTile?,
    onDismiss: () -> Unit,
    onOpenInLibrary: (LibraryTile) -> Unit,
    onFindOnPearTube: () -> Unit,
    onSelectGenre: (String) -> Unit,
    onSearchCast: (String) -> Unit,
) {
    val haptics = LocalHapticFeedback.current
    val isSeries = item.kind == "series"
    val fullMeta by produceState<CinemaTitleMeta?>(
        initialValue = ExternalDiscoveryApi.cachedTitleMeta(item.imdbId, isSeries = isSeries),
        key1 = item.imdbId,
        key2 = isSeries,
    ) {
        value = ExternalDiscoveryApi.loadTitleMeta(item.imdbId, isSeries = isSeries)
    }

    val backdropUrl = fullMeta?.backdropUrl?.takeIf { it.isNotBlank() }
        ?: item.backdropUrl.takeIf { it.isNotBlank() }
        ?: imdbBackdropUrl(item.imdbId)
    val posterUrl = fullMeta?.posterUrl?.takeIf { it.isNotBlank() }
        ?: item.posterUrl.takeIf { it.isNotBlank() }
        ?: imdbPosterUrl(item.imdbId)
    val backdropBitmap by produceState<ImageBitmap?>(
        initialValue = backdropUrl?.let { ExternalImageCache.get(it) }
            ?: posterUrl?.let { ExternalImageCache.get(it) },
        key1 = backdropUrl,
        key2 = posterUrl,
    ) {
        value = when {
            backdropUrl != null -> ExternalImageCache.load(backdropUrl)
                ?: posterUrl?.let { ExternalImageCache.load(it) }
            posterUrl != null -> ExternalImageCache.load(posterUrl)
            else -> null
        }
    }

    val year = fullMeta?.year?.takeIf { it.isNotBlank() } ?: item.year
    val runtime = fullMeta?.runtime?.takeIf { it.isNotBlank() } ?: item.runtime
    val rating = fullMeta?.rating?.takeIf { it.isNotBlank() } ?: item.rating
    val genres = fullMeta?.genres?.takeIf { it.isNotEmpty() } ?: item.genres
    val description = fullMeta?.description?.takeIf { it.isNotBlank() } ?: item.description
    val cast = fullMeta?.cast?.takeIf { it.isNotEmpty() } ?: item.cast

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        containerColor = CardBg,
        scrimColor = Bg.copy(alpha = 0.78f),
        dragHandle = null,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        modifier = Modifier.statusBarsPadding(),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .navigationBarsPadding()
                .padding(bottom = 24.dp),
        ) {
            // Full-width 16:9 real backdrop melting cleanly into CardBg
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .aspectRatio(16f / 9f)
                    .background(CardElevated),
            ) {
                val art = backdropBitmap
                if (art != null) {
                    Image(
                        bitmap = art,
                        contentDescription = item.title,
                        contentScale = ContentScale.Crop,
                        modifier = Modifier.fillMaxSize(),
                    )
                }
                Canvas(Modifier.fillMaxSize()) {
                    drawRect(
                        Brush.verticalGradient(
                            0.0f to Bg.copy(alpha = 0.30f),
                            0.45f to Color.Transparent,
                            0.82f to CardBg.copy(alpha = 0.85f),
                            1.0f to CardBg,
                        ),
                    )
                }
                Box(
                    modifier = Modifier
                        .align(Alignment.TopEnd)
                        .padding(14.dp)
                        .size(34.dp)
                        .clip(CircleShape)
                        .background(Bg.copy(alpha = 0.64f))
                        .border(0.75.dp, GlassBorder, CircleShape)
                        .semantics { contentDescription = "Close" }
                        .clickable(onClick = onDismiss),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(CloseIcon, null, tint = Ink, modifier = Modifier.size(17.dp))
                }
            }

            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 20.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Text(
                    text = item.title,
                    color = Ink,
                    fontSize = 23.sp,
                    lineHeight = 27.sp,
                    fontFamily = FontFamily.SansSerif,
                    fontWeight = FontWeight.Bold,
                    letterSpacing = (-0.6).sp,
                )

                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    val infoLine = listOfNotNull(
                        year.takeIf { it.isNotBlank() },
                        runtime.takeIf { it.isNotBlank() },
                        if (isSeries) "TV Show" else "Movie",
                    ).joinToString(" · ")
                    Text(infoLine, color = Ink.copy(alpha = 0.80f), fontSize = 13.sp, fontWeight = FontWeight.Medium)
                    if (rating.isNotBlank()) {
                        Text("·", color = Dim, fontSize = 13.sp)
                        Text("★ $rating", color = Warn, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                    }
                }

                if (genres.isNotEmpty()) {
                    FlowRow(
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        genres.take(4).forEach { genre ->
                            Box(
                                modifier = Modifier
                                    .clip(PillShape)
                                    .background(GlassBg)
                                    .border(0.75.dp, GlassBorder, PillShape)
                                    .clickable { onSelectGenre(genre) }
                                    .padding(horizontal = 11.dp, vertical = 5.dp),
                                contentAlignment = Alignment.Center,
                            ) {
                                Text(
                                    text = genre,
                                    color = Ink.copy(alpha = 0.88f),
                                    fontSize = 11.5.sp,
                                    fontWeight = FontWeight.Medium,
                                    maxLines = 1,
                                )
                            }
                        }
                    }
                }

                if (description.isNotBlank()) {
                    Text(
                        text = description,
                        color = Ink.copy(alpha = 0.86f),
                        fontSize = 14.sp,
                        lineHeight = 20.sp,
                    )
                }

                if (cast.isNotEmpty()) {
                    Column(verticalArrangement = Arrangement.spacedBy(7.dp)) {
                        Text(
                            text = "Starring",
                            color = Dim,
                            fontSize = 11.5.sp,
                            fontWeight = FontWeight.SemiBold,
                        )
                        FlowRow(
                            horizontalArrangement = Arrangement.spacedBy(7.dp),
                            verticalArrangement = Arrangement.spacedBy(7.dp),
                        ) {
                            cast.take(4).forEach { actor ->
                                Box(
                                    modifier = Modifier
                                        .clip(PillShape)
                                        .background(CardElevated)
                                        .border(0.5.dp, GlassBorder, PillShape)
                                        .clickable { onSearchCast(actor) }
                                        .padding(horizontal = 10.dp, vertical = 5.dp),
                                    contentAlignment = Alignment.Center,
                                ) {
                                    Text(
                                        text = actor,
                                        color = Ink.copy(alpha = 0.86f),
                                        fontSize = 11.5.sp,
                                        fontWeight = FontWeight.Medium,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                }
                            }
                        }
                    }
                }

                Spacer(Modifier.height(4.dp))

                if (inLibraryTile != null) {
                    HeroPrimaryButton(
                        text = "Open in Library",
                        icon = PlayIcon,
                        shape = PillShape,
                        onClick = {
                            haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                            onOpenInLibrary(inLibraryTile)
                        },
                        modifier = Modifier.fillMaxWidth().height(48.dp),
                    )
                } else {
                    HeroPrimaryButton(
                        text = "Find on PearTube",
                        icon = SearchIcon,
                        shape = PillShape,
                        onClick = {
                            haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                            onFindOnPearTube()
                        },
                        modifier = Modifier.fillMaxWidth().height(48.dp),
                    )
                }
            }
        }
    }
}

@Composable
private fun NetworkChannelsSection(
    discovered: List<com.peartube.app.DiscoveredSource>,
    onFollow: (com.peartube.app.DiscoveredSource) -> Unit,
    modifier: Modifier = Modifier,
) {
    if (discovered.isEmpty()) {
        Text(
            text = "Wi-Fi channels appear here automatically when a relay is nearby",
            color = Dim.copy(alpha = 0.72f),
            fontSize = 12.sp,
            modifier = modifier.padding(top = 4.dp),
        )
        return
    }
    Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        HorizontalDivider(color = Line.copy(alpha = 0.35f))
        Spacer(Modifier.height(4.dp))
        Text("Channels on your network", color = Ink, fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
        discovered.forEachIndexed { idx, found ->
            if (idx > 0) HorizontalDivider(color = Line.copy(alpha = 0.3f))
            Row(
                Modifier
                    .fillMaxWidth()
                    .padding(vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(found.title.ifBlank { "Channel ${found.key.take(8)}" }, color = Ink, fontSize = 15.sp, fontWeight = FontWeight.Medium)
                    if (found.via.isNotBlank()) {
                        Text(found.via, color = Dim, fontSize = 12.sp)
                    }
                }
                Box(
                    modifier = Modifier
                        .clip(PillShape)
                        .background(GlassBg)
                        .border(0.75.dp, GlassBorder, PillShape)
                        .clickable { onFollow(found) }
                        .padding(horizontal = 13.dp, vertical = 6.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text("Follow", color = Ink, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                }
            }
        }
    }
}

@Composable
private fun CreatorSuggestionRow(
    suggestion: CreatorSuggestion,
    followed: Boolean,
    busy: Boolean,
    primary: Boolean = false,
    onFollow: () -> Unit,
    onUnfollow: (() -> Unit)? = null,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(enabled = !busy && (!followed || onUnfollow != null)) {
                if (followed) onUnfollow?.invoke() else onFollow()
            }
            .padding(horizontal = 12.dp, vertical = 9.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        ExternalAvatar(
            url = suggestion.avatarUrl,
            name = suggestion.name,
            accent = if (suggestion.source == "peartube") Accent else sourceAccentColor(suggestion.source),
            modifier = Modifier.size(38.dp),
        )
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
            Text(
                text = suggestion.name,
                color = Ink,
                fontSize = 14.sp,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            val sub = listOfNotNull(
                suggestion.handle.takeIf { it.isNotBlank() },
                suggestion.subscribers.takeIf { it.isNotBlank() },
            ).joinToString(" · ")
            if (sub.isNotEmpty()) {
                Text(
                    text = sub,
                    color = Dim,
                    fontSize = 12.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        if (followed) {
            if (onUnfollow != null) {
                Row(
                    modifier = Modifier
                        .clip(PillShape)
                        .background(GlassBg)
                        .border(0.75.dp, Accent.copy(alpha = 0.45f), PillShape)
                        .clickable(enabled = !busy, onClick = onUnfollow)
                        .padding(horizontal = 10.dp, vertical = 5.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    Text(
                        text = "Following",
                        color = Accent,
                        fontSize = 11.5.sp,
                        fontWeight = FontWeight.SemiBold,
                        maxLines = 1,
                    )
                    Icon(
                        imageVector = CloseIcon,
                        contentDescription = "Unfollow ${suggestion.name}",
                        tint = Dim,
                        modifier = Modifier.size(13.dp),
                    )
                }
            } else {
                SourceBadge(text = "Following", highlight = true)
            }
        } else {
            Box(
                modifier = Modifier
                    .clip(PillShape)
                    .background(if (primary) Pearl else GlassBg)
                    .then(
                        if (primary) Modifier else Modifier.border(0.75.dp, GlassBorder, PillShape),
                    )
                    .clickable(enabled = !busy, onClick = onFollow)
                    .padding(horizontal = 12.dp, vertical = 6.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = if (primary) "+ Follow" else "Follow",
                    color = if (primary) PearlInk else Ink,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.SemiBold,
                )
            }
        }
    }
}

@Composable
private fun MoodPill(
    label: String,
    selected: Boolean,
    onClick: () -> Unit,
) {
    Box(
        modifier = Modifier
            .clip(PillShape)
            .background(if (selected) Brand.copy(alpha = 0.22f) else GlassBg)
            .border(0.75.dp, if (selected) Brand.copy(alpha = 0.65f) else GlassBorder, PillShape)
            .clickable(onClick = onClick)
            .padding(horizontal = 13.dp, vertical = 7.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = label,
            color = if (selected) Ink else Dim,
            fontSize = 12.sp,
            fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Medium,
            maxLines = 1,
        )
    }
}

@Composable
private fun SuggestedArtistCard(
    artist: SuggestedArtist,
    onClick: () -> Unit,
) {
    Column(
        modifier = Modifier
            .width(82.dp)
            .clickable(onClick = onClick),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(7.dp),
    ) {
        ExternalAvatar(
            url = artist.artUrl,
            name = artist.name,
            modifier = Modifier.size(76.dp),
        )
        Text(
            text = artist.name,
            color = Ink,
            fontSize = 12.sp,
            fontWeight = FontWeight.Medium,
            textAlign = TextAlign.Center,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

@Composable
private fun SuggestedSongRow(
    song: SuggestedSong,
    musicState: MusicState,
    onToggleStream: () -> Unit,
    onGet: () -> Unit,
) {
    val isThis = musicState.currentTrack?.key == "ext:song:${song.id}"
    val isPlaying = isThis && musicState.playing
    val isLoading = isThis && musicState.buffering && musicState.playing
    val durText = if (song.durationSecs > 0) clock(song.durationSecs * 1000L) else ""

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .then(if (isThis) Modifier.clip(CardShape).background(Brand.copy(alpha = 0.10f)) else Modifier)
            .clickable(onClick = onToggleStream)
            .padding(vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Box(
            modifier = Modifier
                .size(48.dp)
                .clip(RoundedCornerShape(10.dp)),
            contentAlignment = Alignment.Center,
        ) {
            ExternalArtwork(
                url = song.artUrl,
                title = song.title,
                cornerRadius = 10.dp,
                modifier = Modifier.fillMaxSize(),
            )
            Box(
                modifier = Modifier
                    .size(24.dp)
                    .clip(CircleShape)
                    .background(OverlayPanelBg.copy(alpha = if (isThis) 0.78f else 0.62f)),
                contentAlignment = Alignment.Center,
            ) {
                when {
                    isLoading -> CircularProgressIndicator(
                        color = Color.White,
                        strokeWidth = 1.75.dp,
                        modifier = Modifier.size(13.dp),
                    )
                    isPlaying -> Icon(
                        imageVector = StopPreviewIcon,
                        contentDescription = "Pause stream",
                        tint = Color.White,
                        modifier = Modifier.size(12.dp),
                    )
                    else -> Icon(
                        imageVector = PlayPreviewIcon,
                        contentDescription = "Stream full track",
                        tint = Color.White,
                        modifier = Modifier.size(12.dp),
                    )
                }
            }
        }

        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                text = song.title,
                color = if (isThis) BrandHover else Ink,
                fontSize = 14.sp,
                fontWeight = FontWeight.Medium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            val sub = listOfNotNull(
                song.artist.takeIf { it.isNotBlank() },
                song.album.takeIf { it.isNotBlank() },
            ).joinToString(" · ")
            if (sub.isNotEmpty()) {
                Text(
                    text = sub,
                    color = Dim,
                    fontSize = 12.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }

        if (durText.isNotEmpty()) {
            Text(durText, color = Dim, fontSize = 11.sp)
        }

        Box(
            modifier = Modifier
                .size(36.dp)
                .clip(CircleShape)
                .semantics { contentDescription = "Find ${song.title}" }
                .clickable(onClick = onGet),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                imageVector = AddIcon,
                contentDescription = null,
                tint = Dim,
                modifier = Modifier.size(18.dp),
            )
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun SuggestedAlbumCard(
    album: SuggestedAlbum,
    onClick: () -> Unit,
    onLongClick: (() -> Unit)? = null,
) {
    Column(
        modifier = Modifier
            .width(132.dp)
            .combinedClickable(
                onClick = onClick,
                onLongClick = onLongClick,
            ),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        ExternalArtwork(
            url = album.artUrl,
            title = album.title,
            cornerRadius = 12.dp,
            modifier = Modifier.size(132.dp),
        )
        Text(
            text = album.title,
            color = Ink,
            fontSize = 13.sp,
            fontWeight = FontWeight.Medium,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        val sub = listOfNotNull(
            album.artist.takeIf { it.isNotBlank() },
            album.year.takeIf { it.isNotBlank() },
        ).joinToString(" · ")
        if (sub.isNotEmpty()) {
            Text(
                text = sub,
                color = Dim,
                fontSize = 12.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

internal fun findFollowedCreator(
    creators: List<DiscoverCreator>,
    id: String,
    url: String,
    handle: String,
    source: String,
    name: String,
): DiscoverCreator? {
    val normUrl = url.trim().lowercase(Locale.ROOT)
    val normHandle = handle.trim().removePrefix("@").lowercase(Locale.ROOT)
    val normSource = source.trim().lowercase(Locale.ROOT)
    val normName = name.trim().lowercase(Locale.ROOT)
    return creators.firstOrNull { c ->
        (id.isNotBlank() && c.id == id) ||
            (normUrl.isNotEmpty() && c.url.trim().lowercase(Locale.ROOT) == normUrl) ||
            (normHandle.isNotEmpty() && c.handle.trim().removePrefix("@").lowercase(Locale.ROOT) == normHandle) ||
            (normName.isNotEmpty() && c.source.lowercase(Locale.ROOT) == normSource && c.name.trim().lowercase(Locale.ROOT) == normName)
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun DiscoverCreatorChip(
    creator: DiscoverCreator,
    apiUrl: String?,
    selected: Boolean,
    onSelect: () -> Unit,
    onUnfollow: () -> Unit,
) {
    val haptics = LocalHapticFeedback.current
    var menuOpen by remember { mutableStateOf(false) }

    Box {
        Row(
            modifier = Modifier
                .clip(PillShape)
                .background(if (selected) Brand.copy(alpha = 0.24f) else CardBg)
                .border(1.dp, if (selected) Brand else Line, PillShape)
                .combinedClickable(
                    onClick = onSelect,
                    onLongClick = {
                        haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                        menuOpen = true
                    },
                )
                .padding(start = 7.dp, end = 4.dp, top = 4.dp, bottom = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            LoopbackAvatar(
                apiUrl = apiUrl,
                path = creator.avatar,
                name = creator.displayName,
                source = creator.source,
                modifier = Modifier.size(24.dp),
            )
            Text(
                text = creator.displayName,
                color = Ink,
                fontSize = 12.5.sp,
                fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Medium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Box(
                modifier = Modifier
                    .size(30.dp)
                    .clip(CircleShape)
                    .background(GlassHighlight)
                    .clickable(onClick = onUnfollow),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    imageVector = CloseIcon,
                    contentDescription = "Unfollow ${creator.displayName}",
                    tint = Ink.copy(alpha = 0.78f),
                    modifier = Modifier.size(14.dp),
                )
            }
        }
        DropdownMenu(
            expanded = menuOpen,
            onDismissRequest = { menuOpen = false },
            containerColor = CardElevated,
        ) {
            DropdownMenuItem(
                text = { Text("Filter feed by ${creator.displayName}", color = Ink) },
                onClick = {
                    menuOpen = false
                    onSelect()
                },
            )
            DropdownMenuItem(
                text = { Text("Unfollow ${creator.displayName}", color = Danger) },
                onClick = {
                    menuOpen = false
                    onUnfollow()
                },
            )
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ManageFollowingSheet(
    creators: List<DiscoverCreator>,
    apiUrl: String?,
    onDismiss: () -> Unit,
    onUnfollow: (DiscoverCreator) -> Unit,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = CardBg,
        contentColor = Ink,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 20.dp)
                .padding(bottom = 28.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(
                        text = "Following",
                        color = Ink,
                        fontSize = 19.sp,
                        fontWeight = FontWeight.Bold,
                    )
                    Text(
                        text = plural(creators.size, "creator", "creators"),
                        color = Dim,
                        fontSize = 12.5.sp,
                    )
                }
                TextButton(onClick = onDismiss) {
                    Text("Done", color = BrandHover, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
                }
            }
            HorizontalDivider(color = Line.copy(alpha = 0.45f))
            LazyColumn(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(max = 420.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                items(creators, key = { "manage-${it.id}" }) { creator ->
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(CardShape)
                            .background(CardElevated)
                            .border(0.75.dp, GlassBorder, CardShape)
                            .padding(horizontal = 12.dp, vertical = 10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        LoopbackAvatar(
                            apiUrl = apiUrl,
                            path = creator.avatar,
                            name = creator.displayName,
                            source = creator.source,
                            modifier = Modifier.size(40.dp),
                        )
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            Text(
                                text = creator.displayName,
                                color = Ink,
                                fontSize = 14.5.sp,
                                fontWeight = FontWeight.SemiBold,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                            val sub = listOfNotNull(
                                creator.handle.takeIf { it.isNotBlank() },
                                sourceDisplayLabel(creator.source).takeIf { it.isNotBlank() },
                            ).joinToString(" · ")
                            if (sub.isNotEmpty()) {
                                Text(
                                    text = sub,
                                    color = Dim,
                                    fontSize = 12.sp,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            }
                        }
                        Box(
                            modifier = Modifier
                                .clip(PillShape)
                                .background(Danger.copy(alpha = 0.14f))
                                .border(0.75.dp, Danger.copy(alpha = 0.45f), PillShape)
                                .clickable { onUnfollow(creator) }
                                .padding(horizontal = 12.dp, vertical = 7.dp),
                            contentAlignment = Alignment.Center,
                        ) {
                            Text(
                                text = "Unfollow",
                                color = Danger,
                                fontSize = 12.sp,
                                fontWeight = FontWeight.SemiBold,
                                maxLines = 1,
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun DiscoverBrowseCreatorCard(
    creator: DiscoverCreator,
    apiUrl: String?,
    followed: Boolean,
    followBusy: Boolean,
    onFollow: () -> Unit,
    onUnfollow: (() -> Unit)? = null,
) {
    Row(
        modifier = Modifier
            .clip(CardShape)
            .background(CardBg)
            .border(1.dp, Line, CardShape)
            .padding(horizontal = 10.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        LoopbackAvatar(
            apiUrl = apiUrl,
            path = creator.avatar,
            name = creator.displayName,
            source = creator.source,
            modifier = Modifier.size(30.dp),
        )
        Column(verticalArrangement = Arrangement.spacedBy(1.dp)) {
            Text(
                text = creator.displayName,
                color = Ink,
                fontSize = 13.sp,
                fontWeight = FontWeight.Medium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = sourceDisplayLabel(creator.source),
                color = Dim,
                fontSize = 11.sp,
            )
        }
        if (followed) {
            if (onUnfollow != null) {
                Row(
                    modifier = Modifier
                        .clip(PillShape)
                        .background(GlassBg)
                        .border(0.75.dp, Accent.copy(alpha = 0.45f), PillShape)
                        .clickable(enabled = !followBusy, onClick = onUnfollow)
                        .padding(horizontal = 9.dp, vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    Text(
                        text = "Following",
                        color = Accent,
                        fontSize = 11.sp,
                        fontWeight = FontWeight.SemiBold,
                    )
                    Icon(
                        imageVector = CloseIcon,
                        contentDescription = "Unfollow ${creator.displayName}",
                        tint = Dim,
                        modifier = Modifier.size(12.dp),
                    )
                }
            } else {
                SourceBadge(text = "Following", highlight = true)
            }
        } else {
            TextButton(
                enabled = !followBusy,
                onClick = onFollow,
                contentPadding = PaddingValues(horizontal = 8.dp, vertical = 2.dp),
            ) {
                Text("Follow", color = Brand, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
            }
        }
    }
}

@Composable
private fun DiscoverSoftErrorBanner(
    errors: List<DiscoverFeedError>,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier
            .fillMaxWidth()
            .clip(CardShape)
            .background(Warn.copy(alpha = 0.12f))
            .border(1.dp, Warn.copy(alpha = 0.36f), CardShape)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        errors.take(4).forEach { err ->
            Text(
                text = "${err.label}: ${err.message}",
                color = Warn,
                fontSize = 12.sp,
            )
        }
        if (errors.size > 4) {
            Text(
                text = "+ ${errors.size - 4} more source notes",
                color = Dim,
                fontSize = 11.sp,
            )
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ExternalVideoCard(
    video: ExternalVideoPick,
    inLibrary: Boolean,
    isAdding: Boolean,
    onAdd: () -> Unit,
    onAddAudio: () -> Unit,
    onLongClick: (() -> Unit)? = null,
    modifier: Modifier = Modifier,
) {
    val thumbBitmap by produceState<ImageBitmap?>(
        initialValue = video.thumbUrl.takeIf { it.isNotBlank() }?.let { ExternalImageCache.get(it) },
        key1 = video.thumbUrl,
    ) {
        value = if (video.thumbUrl.isNotBlank()) ExternalImageCache.load(video.thumbUrl) else null
    }

    Column(
        modifier = modifier
            .fillMaxWidth()
            .then(
                if (onLongClick != null) {
                    Modifier.combinedClickable(
                        interactionSource = remember { MutableInteractionSource() },
                        indication = null,
                        onClick = {},
                        onLongClick = onLongClick,
                    )
                } else {
                    Modifier
                },
            ),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .aspectRatio(16f / 9f)
                .clip(CardShape)
                .background(CardElevated)
                .border(0.5.dp, GlassBorder, CardShape),
            contentAlignment = Alignment.Center,
        ) {
            val loaded = thumbBitmap
            if (loaded != null) {
                Image(
                    bitmap = loaded,
                    contentDescription = video.title,
                    contentScale = ContentScale.Crop,
                    modifier = Modifier.fillMaxSize(),
                )
            } else {
                Icon(
                    imageVector = WatchIcon,
                    contentDescription = null,
                    tint = SourceYoutube.copy(alpha = 0.65f),
                    modifier = Modifier.size(32.dp),
                )
            }
            Box(
                modifier = Modifier
                    .align(Alignment.TopStart)
                    .padding(10.dp)
                    .clip(PillShape)
                    .background(Bg.copy(alpha = 0.78f))
                    .border(0.75.dp, SourceYoutube.copy(alpha = 0.50f), PillShape)
                    .padding(horizontal = 9.dp, vertical = 3.dp),
            ) {
                Text(
                    text = "YouTube",
                    color = Ink,
                    fontSize = 11.sp,
                    fontWeight = FontWeight.SemiBold,
                )
            }
            if (video.durationText.isNotBlank()) {
                Box(
                    modifier = Modifier
                        .align(Alignment.BottomEnd)
                        .padding(10.dp)
                        .clip(RoundedCornerShape(6.dp))
                        .background(Bg.copy(alpha = 0.84f))
                        .padding(horizontal = 7.dp, vertical = 3.dp),
                ) {
                    Text(
                        text = video.durationText,
                        color = Ink,
                        fontSize = 11.sp,
                        fontWeight = FontWeight.Medium,
                    )
                }
            }
        }

        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(
                text = video.title,
                color = Ink,
                fontSize = 15.sp,
                fontWeight = FontWeight.SemiBold,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )

            val meta = listOfNotNull(
                video.channelName.takeIf { it.isNotBlank() },
                video.publishedText.takeIf { it.isNotBlank() },
            ).joinToString(" · ")
            if (meta.isNotEmpty()) {
                Text(
                    text = meta,
                    color = Dim,
                    fontSize = 12.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }

            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                when {
                    inLibrary -> {
                        Row(
                            modifier = Modifier
                                .clip(PillShape)
                                .background(Accent.copy(alpha = 0.16f))
                                .border(0.75.dp, Accent.copy(alpha = 0.45f), PillShape)
                                .padding(horizontal = 12.dp, vertical = 7.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(5.dp),
                        ) {
                            Icon(CheckIcon, null, tint = Accent, modifier = Modifier.size(15.dp))
                            Text("In library", color = Accent, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                        }
                    }
                    isAdding -> {
                        Row(
                            modifier = Modifier
                                .clip(PillShape)
                                .background(GlassBg)
                                .border(0.75.dp, GlassBorder, PillShape)
                                .padding(horizontal = 12.dp, vertical = 7.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            CircularProgressIndicator(color = Brand, strokeWidth = 2.dp, modifier = Modifier.size(14.dp))
                            Text("Adding…", color = Ink, fontSize = 12.sp, fontWeight = FontWeight.Medium)
                        }
                    }
                    else -> {
                        Row(
                            modifier = Modifier
                                .clip(PillShape)
                                .background(Pearl)
                                .clickable(onClick = onAdd)
                                .padding(horizontal = 14.dp, vertical = 7.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(5.dp),
                        ) {
                            Icon(AddIcon, null, tint = PearlInk, modifier = Modifier.size(15.dp))
                            Text("Add", color = PearlInk, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                        }
                    }
                }

                if (!isAdding) {
                    Row(
                        modifier = Modifier
                            .clip(PillShape)
                            .background(GlassBg)
                            .border(0.75.dp, GlassBorder, PillShape)
                            .clickable(onClick = onAddAudio)
                            .padding(horizontal = 12.dp, vertical = 7.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(5.dp),
                    ) {
                        Icon(AudioIcon, null, tint = Ink, modifier = Modifier.size(15.dp))
                        Text("Audio", color = Ink, fontSize = 12.sp, fontWeight = FontWeight.Medium)
                    }
                }
            }
        }
    }
}

@Composable
private fun DiscoverItemCard(
    item: DiscoverItem,
    apiUrl: String?,
    inLibrary: Boolean,
    isAdding: Boolean,
    showFollowCreator: Boolean,
    followBusy: Boolean,
    onAdd: () -> Unit,
    onAddAudio: () -> Unit,
    onFollowCreator: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val sourceColor = sourceAccentColor(item.source)
    Column(
        modifier = modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .aspectRatio(16f / 9f)
                .clip(CardShape),
        ) {
            LoopbackThumbnail(
                apiUrl = apiUrl,
                path = item.thumbnail,
                source = item.source,
                audioOnly = item.audioOnly,
                contentDescription = item.title,
                modifier = Modifier.fillMaxSize(),
            )
            Box(
                modifier = Modifier
                    .align(Alignment.TopStart)
                    .padding(10.dp)
                    .clip(PillShape)
                    .background(Bg.copy(alpha = 0.78f))
                    .border(0.75.dp, sourceColor.copy(alpha = 0.50f), PillShape)
                    .padding(horizontal = 9.dp, vertical = 3.dp),
            ) {
                Text(
                    text = sourceDisplayLabel(item.source),
                    color = Ink,
                    fontSize = 11.sp,
                    fontWeight = FontWeight.SemiBold,
                )
            }
            item.durationSec?.let { dur ->
                Box(
                    modifier = Modifier
                        .align(Alignment.BottomEnd)
                        .padding(10.dp)
                        .clip(RoundedCornerShape(6.dp))
                        .background(Bg.copy(alpha = 0.84f))
                        .padding(horizontal = 7.dp, vertical = 3.dp),
                ) {
                    Text(
                        text = clock(dur * 1000L),
                        color = Ink,
                        fontSize = 11.sp,
                        fontWeight = FontWeight.Medium,
                    )
                }
            }
        }

        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(
                text = item.title,
                color = Ink,
                fontSize = 15.sp,
                fontWeight = FontWeight.SemiBold,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )

            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                val relDate = remember(item.publishedAt) { formatRelativePublished(item.publishedAt) }
                val meta = listOfNotNull(
                    item.creatorName.takeIf { it.isNotBlank() },
                    relDate.takeIf { it.isNotBlank() },
                ).joinToString(" · ")
                Text(
                    text = meta.ifBlank { sourceDisplayLabel(item.source) },
                    color = Dim,
                    fontSize = 12.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                if (showFollowCreator) {
                    TextButton(
                        enabled = !followBusy,
                        onClick = onFollowCreator,
                        contentPadding = PaddingValues(horizontal = 8.dp, vertical = 2.dp),
                    ) {
                        Text("Follow", color = Brand, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                    }
                }
            }

            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                when {
                    inLibrary -> {
                        Row(
                            modifier = Modifier
                                .clip(PillShape)
                                .background(Accent.copy(alpha = 0.16f))
                                .border(0.75.dp, Accent.copy(alpha = 0.45f), PillShape)
                                .padding(horizontal = 12.dp, vertical = 7.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(5.dp),
                        ) {
                            Icon(CheckIcon, null, tint = Accent, modifier = Modifier.size(15.dp))
                            Text("In library", color = Accent, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                        }
                    }
                    isAdding -> {
                        Row(
                            modifier = Modifier
                                .clip(PillShape)
                                .background(GlassBg)
                                .border(0.75.dp, GlassBorder, PillShape)
                                .padding(horizontal = 12.dp, vertical = 7.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            CircularProgressIndicator(color = Brand, strokeWidth = 2.dp, modifier = Modifier.size(14.dp))
                            Text("Adding…", color = Ink, fontSize = 12.sp, fontWeight = FontWeight.Medium)
                        }
                    }
                    else -> {
                        Row(
                            modifier = Modifier
                                .clip(PillShape)
                                .background(Pearl)
                                .clickable(onClick = onAdd)
                                .padding(horizontal = 14.dp, vertical = 7.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(5.dp),
                        ) {
                            Icon(AddIcon, null, tint = PearlInk, modifier = Modifier.size(15.dp))
                            Text("Add", color = PearlInk, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                        }
                    }
                }

                if (!item.audioOnly && !isAdding) {
                    Row(
                        modifier = Modifier
                            .clip(PillShape)
                            .background(GlassBg)
                            .border(0.75.dp, GlassBorder, PillShape)
                            .clickable(onClick = onAddAudio)
                            .padding(horizontal = 12.dp, vertical = 7.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(5.dp),
                    ) {
                        Icon(AudioIcon, null, tint = Ink, modifier = Modifier.size(15.dp))
                        Text("Audio", color = Ink, fontSize = 12.sp, fontWeight = FontWeight.Medium)
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class, ExperimentalLayoutApi::class)
@Composable
fun SearchScreen(
    model: AppModel,
    catalog: LibraryCatalog,
    onOpenAlbum: (String) -> Unit,
    onOpenTitle: (String) -> Unit,
    topPadding: Dp = 8.dp,
    bottomPadding: Dp = 28.dp,
) {
    val query by model.query.collectAsState()
    val searchScope by model.searchScope.collectAsState()
    val recentSearches by model.recentSearches.collectAsState()
    val global by model.global.collectAsState()
    val sourceSearch by model.sourceSearch.collectAsState()
    val selectedSources by model.selectedSources.collectAsState()
    val soulseekSettings by model.soulseekSettings.collectAsState()
    val plugins by model.plugins.collectAsState()
    val autoFocus by model.searchAutoFocus.collectAsState()
    val musicState by model.musicState.collectAsState()
    val ytmSearch by model.ytmSearch.collectAsState()
    val ytmSearchBusy by model.ytmSearchBusy.collectAsState()
    val creatorSuggestions by model.creatorSuggestions.collectAsState()
    val creatorSuggestBusy by model.creatorSuggestBusy.collectAsState()
    val creators by model.discoverCreators.collectAsState()
    val followBusy by model.discoverFollowBusy.collectAsState()
    var scanner by remember { mutableStateOf(false) }
    var pendingYouTubeSave by remember { mutableStateOf<YouTubeCandidate?>(null) }

    val focusRequester = remember { FocusRequester() }
    val focusManager = LocalFocusManager.current
    val haptics = LocalHapticFeedback.current

    LaunchedEffect(autoFocus) {
        if (autoFocus) {
            runCatching { focusRequester.requestFocus() }
            model.searchAutoFocus.value = false
        }
    }

    val trimmed = query.trim()
    val isLink = isSearchLink(trimmed)

    // Live debounced Music catalog + @handle / Creator typeahead inside Search
    LaunchedEffect(trimmed, isLink) {
        if (isLink || trimmed.length < 2) {
            model.clearCreatorSuggestions()
            model.searchMusicCatalog("")
        } else {
            model.searchMusicCatalog(trimmed)
            delay(300L)
            model.searchCreatorSuggestions(trimmed)
        }
    }

    val followedCreatorIds = remember(creators) { creators.map { it.id }.toSet() }
    val followedCreatorUrls = remember(creators) { creators.map { it.url.lowercase(Locale.ROOT) }.toSet() }

    val matcher = remember(trimmed) { findIn(trimmed) }
    val matchedAlbums = remember(catalog.albums, matcher, isLink) {
        if (isLink || matcher.isEmpty) emptyList()
        else catalog.albums.filter { matcher.matches(it.title) || matcher.matches(it.album) || matcher.matches(it.artist) }
    }
    val matchedTracks = remember(catalog.allTracks, matcher, isLink) {
        if (isLink || matcher.isEmpty) emptyList()
        else catalog.allTracks.filter { matcher.matchesTrack(it.name, "${it.album.title} ${it.artist}") }
    }
    val matchedFilms = remember(catalog.movies, catalog.series, matcher, isLink) {
        if (isLink || matcher.isEmpty) emptyList()
        else (catalog.movies + catalog.series).filter { matcher.matches(it.title) }
    }
    val matchedClips = remember(catalog.clips, matcher, isLink) {
        if (isLink || matcher.isEmpty) emptyList()
        else catalog.clips.filter { matcher.matches(it.title) }
    }

    val libraryCount = matchedFilms.size + matchedAlbums.size + matchedTracks.size + matchedClips.size
    val hasLibraryHits = libraryCount > 0
    val ownedTrackSignatures = remember(catalog.allTracks) {
        catalog.allTracks.map { "${fold(it.artist)}|${fold(it.name)}" }.toHashSet()
    }
    val musicCatalogMatch = ytmSearch.query.equals(trimmed, ignoreCase = true)
    val musicResult = if (musicCatalogMatch) ytmSearch else com.peartube.app.YtmSearchResult(trimmed)
    val musicCount = musicResult.totalCount
    val musicBusy = trimmed.length >= 2 && !trimmed.startsWith("@") && !isLink && ytmSearchBusy
    val creatorCount = creatorSuggestions.size
    val askedSources = trimmed.length >= 2 && sourceSearch.query == trimmed
    val sourcesCount = if (askedSources) {
        sourceSearch.result.soulseek.size +
            sourceSearch.result.youtube.size +
            sourceSearch.result.soundcloud.size +
            sourceSearch.result.rumble.size
    } else {
        0
    }
    val sourcesBusy = askedSources && sourceSearch.busy
    val askedRelays = trimmed.length >= 2 && global.query == trimmed
    val relaysCount = if (askedRelays) global.rows.size else 0
    val relaysBusy = askedRelays && global.busy

    val soulseekPlugin = remember(plugins) { plugins.firstOrNull { it.name.equals("soulseek", ignoreCase = true) } }
    val soulseekConfigured = soulseekSettings.isConfigured || (soulseekPlugin?.configured == true)

    val submit = {
        if (isLink) {
            model.handleSharedText(trimmed)
            model.query.value = ""
            model.searchScope.value = SearchScope.Top
        } else if (trimmed.length >= 2) {
            model.searchAll(trimmed)
        }
        focusManager.clearFocus()
    }

    val sampleArtists = remember(catalog.artists, catalog.movies, catalog.series) {
        val artists = catalog.artists
            .map { it.name }
            .filter { it.isNotBlank() && it != "Unknown artist" }
        val titles = (catalog.movies + catalog.series)
            .map { it.title }
            .filter { it.isNotBlank() }
        (artists + titles).distinctBy { it.lowercase(Locale.ROOT) }.take(8)
    }

    val followSuggestion: (CreatorSuggestion) -> Unit = { suggestion ->
        focusManager.clearFocus()
        val pt = suggestion.peartubeChannel
        if (pt != null) {
            model.subscribeDiscovered(pt)
        } else {
            model.followDiscoverCreator(
                input = suggestion.url,
                name = suggestion.name,
                source = suggestion.source,
                handle = suggestion.handle.takeIf { it.isNotBlank() },
            )
        }
    }

    val openScope: (SearchScope) -> Unit = { target ->
        model.searchScope.value = target
        focusManager.clearFocus()
        if (target == SearchScope.Sources && trimmed.length >= 2 && sourceSearch.query != trimmed) {
            model.searchSources(trimmed)
        } else if (target == SearchScope.Relays && trimmed.length >= 2 && global.query != trimmed) {
            model.searchGlobal(trimmed)
        }
    }

    Column(Modifier.fillMaxSize().padding(top = topPadding)) {
        // Sleek LUMEN PillShape obsidian search bar (48dp, CardElevated, GlassBorder)
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 20.dp, vertical = 6.dp)
                .height(48.dp)
                .clip(PillShape)
                .background(CardElevated)
                .border(0.75.dp, GlassBorder, PillShape)
                .padding(start = 16.dp, end = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Icon(
                imageVector = SearchIcon,
                contentDescription = null,
                tint = Dim,
                modifier = Modifier.size(19.dp),
            )
            Box(
                modifier = Modifier.weight(1f),
                contentAlignment = Alignment.CenterStart,
            ) {
                if (query.isEmpty()) {
                    Text(
                        text = "Titles, artists, @handles, or links…",
                        color = Dim,
                        fontSize = 14.sp,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                BasicTextField(
                    value = query,
                    onValueChange = { next ->
                        model.query.value = next
                        if (next.trim().isEmpty()) {
                            model.searchScope.value = SearchScope.Top
                        }
                    },
                    singleLine = true,
                    textStyle = TextStyle(color = Ink, fontSize = 14.sp),
                    cursorBrush = SolidColor(Pearl),
                    keyboardOptions = KeyboardOptions(
                        capitalization = KeyboardCapitalization.None,
                        autoCorrectEnabled = false,
                        imeAction = ImeAction.Search,
                    ),
                    keyboardActions = KeyboardActions(onSearch = { submit() }),
                    modifier = Modifier
                        .fillMaxWidth()
                        .focusRequester(focusRequester),
                )
            }
            if (query.isNotEmpty()) {
                Box(
                    modifier = Modifier
                        .size(32.dp)
                        .clip(CircleShape)
                        .semantics { contentDescription = "Clear search" }
                        .clickable {
                            model.query.value = ""
                            model.clearCreatorSuggestions()
                            model.searchScope.value = SearchScope.Top
                        },
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(CloseIcon, null, tint = Dim, modifier = Modifier.size(16.dp))
                }
            }
            Box(
                modifier = Modifier
                    .size(32.dp)
                    .clip(CircleShape)
                    .semantics { contentDescription = "Scan QR code" }
                    .clickable { scanner = true },
                contentAlignment = Alignment.Center,
            ) {
                Icon(QrCodeScannerIcon, null, tint = Dim, modifier = Modifier.size(18.dp))
            }
        }

        when {
            isLink -> {
                Column(
                    modifier = Modifier
                        .weight(1f)
                        .fillMaxWidth()
                        .padding(horizontal = 20.dp, vertical = 14.dp),
                ) {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(CardShape)
                            .background(CardElevated)
                            .border(0.75.dp, GlassBorder, CardShape)
                            .padding(16.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Text(
                                text = "Link detected",
                                color = Ink,
                                fontSize = 16.sp,
                                fontWeight = FontWeight.SemiBold,
                            )
                            Text(
                                text = trimmed,
                                color = Dim,
                                fontSize = 12.sp,
                                maxLines = 2,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                        HeroPrimaryButton(
                            text = "Add to library",
                            icon = AddIcon,
                            shape = PillShape,
                            onClick = submit,
                        )
                    }
                }
            }

            trimmed.isEmpty() -> {
                LazyColumn(
                    modifier = Modifier.weight(1f).fillMaxWidth(),
                    contentPadding = PaddingValues(top = 14.dp, bottom = bottomPadding),
                    verticalArrangement = Arrangement.spacedBy(22.dp),
                ) {
                    if (recentSearches.isNotEmpty()) {
                        item(key = "empty-recent") {
                            Column(
                                modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp),
                                verticalArrangement = Arrangement.spacedBy(10.dp),
                            ) {
                                Row(
                                    modifier = Modifier.fillMaxWidth(),
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    Text(
                                        text = "Recent",
                                        color = Dim,
                                        fontSize = 12.sp,
                                        fontWeight = FontWeight.SemiBold,
                                        modifier = Modifier.weight(1f),
                                    )
                                    TextButton(
                                        onClick = { model.clearRecentSearches() },
                                        contentPadding = PaddingValues(horizontal = 6.dp, vertical = 2.dp),
                                    ) {
                                        Text("Clear", color = Dim, fontSize = 12.sp, fontWeight = FontWeight.Medium)
                                    }
                                }
                                FlowRow(
                                    modifier = Modifier.fillMaxWidth(),
                                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                                    verticalArrangement = Arrangement.spacedBy(8.dp),
                                ) {
                                    recentSearches.forEach { term ->
                                        Row(
                                            modifier = Modifier
                                                .clip(PillShape)
                                                .background(GlassBg)
                                                .border(0.75.dp, GlassBorder, PillShape)
                                                .clickable {
                                                    focusManager.clearFocus()
                                                    model.openSearchFor(term, askRelays = false)
                                                }
                                                .padding(start = 13.dp, end = 6.dp, top = 6.dp, bottom = 6.dp),
                                            verticalAlignment = Alignment.CenterVertically,
                                            horizontalArrangement = Arrangement.spacedBy(6.dp),
                                        ) {
                                            Text(
                                                text = term,
                                                color = Ink,
                                                fontSize = 13.sp,
                                                maxLines = 1,
                                                overflow = TextOverflow.Ellipsis,
                                            )
                                            Box(
                                                modifier = Modifier
                                                    .size(22.dp)
                                                    .clip(CircleShape)
                                                    .semantics { contentDescription = "Remove $term" }
                                                    .clickable { model.removeRecentSearch(term) },
                                                contentAlignment = Alignment.Center,
                                            ) {
                                                Icon(CloseIcon, null, tint = Dim, modifier = Modifier.size(13.dp))
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }

                    if (sampleArtists.isNotEmpty()) {
                        item(key = "empty-from-library") {
                            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                                Text(
                                    text = "From your library",
                                    color = Dim,
                                    fontSize = 12.sp,
                                    fontWeight = FontWeight.SemiBold,
                                    modifier = Modifier.padding(horizontal = 20.dp),
                                )
                                LazyRow(
                                    modifier = Modifier.fillMaxWidth(),
                                    contentPadding = PaddingValues(horizontal = 20.dp),
                                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                                ) {
                                    items(sampleArtists, key = { "sample-lib-$it" }) { name ->
                                        Box(
                                            modifier = Modifier
                                                .clip(PillShape)
                                                .background(GlassBg)
                                                .border(0.75.dp, GlassBorder, PillShape)
                                                .clickable {
                                                    focusManager.clearFocus()
                                                    model.openSearchFor(name, askRelays = false)
                                                }
                                                .padding(horizontal = 13.dp, vertical = 7.dp),
                                            contentAlignment = Alignment.Center,
                                        ) {
                                            Text(name, color = Ink, fontSize = 13.sp, maxLines = 1)
                                        }
                                    }
                                }
                            }
                        }
                    }

                    item(key = "empty-quick-jumps") {
                        LazyRow(
                            modifier = Modifier.fillMaxWidth(),
                            contentPadding = PaddingValues(horizontal = 20.dp),
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            item(key = "jump-cinema") {
                                SearchQuickJumpChip(
                                    label = "Browse Movies & TV",
                                    icon = WatchIcon,
                                    onClick = {
                                        focusManager.clearFocus()
                                        model.setDiscoverTab(DiscoverTab.Cinema)
                                        model.selectRoom(Room.Discover)
                                    },
                                )
                            }
                            item(key = "jump-music") {
                                SearchQuickJumpChip(
                                    label = "Browse Music",
                                    icon = ListenIcon,
                                    onClick = {
                                        focusManager.clearFocus()
                                        model.setDiscoverTab(DiscoverTab.Music)
                                        model.selectRoom(Room.Discover)
                                    },
                                )
                            }
                            item(key = "jump-link-qr") {
                                SearchQuickJumpChip(
                                    label = "Paste link or scan QR",
                                    icon = QrCodeScannerIcon,
                                    onClick = {
                                        focusManager.clearFocus()
                                        model.openAddSheet()
                                    },
                                )
                            }
                        }
                    }
                }
            }

            else -> {
                // Single edge-to-edge Scope Pill Strip right below the search bar
                LazyRow(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(top = 4.dp, bottom = 6.dp),
                    contentPadding = PaddingValues(horizontal = 20.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    items(SearchScope.entries, key = { "scope-${it.name}" }) { scope ->
                        val label = when (scope) {
                            SearchScope.Top -> scope.label
                            SearchScope.Music -> if (musicCount > 0) "${scope.label} · $musicCount" else scope.label
                            SearchScope.Library -> if (libraryCount > 0) "${scope.label} · $libraryCount" else scope.label
                            SearchScope.Creators -> if (creatorCount > 0) "${scope.label} · $creatorCount" else scope.label
                            SearchScope.Sources -> if (sourcesCount > 0) "${scope.label} · $sourcesCount" else scope.label
                            SearchScope.Relays -> if (relaysCount > 0) "${scope.label} · $relaysCount" else scope.label
                        }
                        val busy = when (scope) {
                            SearchScope.Music -> musicBusy && musicCount == 0
                            SearchScope.Creators -> creatorSuggestBusy && creatorCount == 0
                            SearchScope.Sources -> sourcesBusy
                            SearchScope.Relays -> relaysBusy
                            else -> false
                        }
                        SearchScopePill(
                            label = label,
                            selected = searchScope == scope,
                            busy = busy,
                            onClick = { openScope(scope) },
                        )
                    }
                }

                val activeKey = musicState.currentTrack?.key

                when (searchScope) {
                    SearchScope.Top -> {
                        LazyColumn(
                            modifier = Modifier.weight(1f).fillMaxWidth(),
                            contentPadding = PaddingValues(top = 6.dp, bottom = bottomPadding),
                            verticalArrangement = Arrangement.spacedBy(18.dp),
                        ) {
                            // RiPlay-style instant Music results (Artists, Top Songs, Albums)
                            val showMusicPreview = trimmed.length >= 2 && !trimmed.startsWith("@") && (musicCount > 0 || musicBusy)
                            if (showMusicPreview) {
                                item(key = "top-music-head") {
                                    SectionHeader(
                                        title = "Music",
                                        actionLabel = if (musicCount > 0) "All music →" else null,
                                        onAction = { openScope(SearchScope.Music) },
                                    )
                                }
                                if (musicBusy && musicCount == 0) {
                                    item(key = "top-music-loading") {
                                        Row(
                                            modifier = Modifier
                                                .fillMaxWidth()
                                                .padding(horizontal = 20.dp),
                                            verticalAlignment = Alignment.CenterVertically,
                                            horizontalArrangement = Arrangement.spacedBy(10.dp),
                                        ) {
                                            CircularProgressIndicator(
                                                color = Brand,
                                                strokeWidth = 2.dp,
                                                modifier = Modifier.size(16.dp),
                                            )
                                            Text("Finding artists, songs & albums…", color = Dim, fontSize = 13.sp)
                                        }
                                    }
                                }
                                if (musicResult.artists.isNotEmpty()) {
                                    item(key = "top-music-artists") {
                                        LazyRow(
                                            contentPadding = PaddingValues(horizontal = 20.dp),
                                            horizontalArrangement = Arrangement.spacedBy(14.dp),
                                        ) {
                                            items(musicResult.artists.take(6), key = { "top-ytm-art-${it.browseId}" }) { artist ->
                                                YtmArtistChipCard(
                                                    artist = artist,
                                                    onClick = {
                                                        focusManager.clearFocus()
                                                        model.openExternalArtist(artist.browseId, artist.name, artist.artUrl)
                                                    },
                                                )
                                            }
                                        }
                                    }
                                }
                                if (musicResult.songs.isNotEmpty()) {
                                    item(key = "top-music-songs") {
                                        Column(
                                            modifier = Modifier.padding(horizontal = 20.dp),
                                            verticalArrangement = Arrangement.spacedBy(6.dp),
                                        ) {
                                            val previewSongs = musicResult.songs.take(4)
                                            previewSongs.forEachIndexed { idx, song ->
                                                val inLib = "${fold(song.artist)}|${fold(song.title)}" in ownedTrackSignatures
                                                val isActive = musicState.currentTrack?.let {
                                                    it.externalVideoId == song.videoId ||
                                                        (fold(it.title) == fold(song.title) && fold(it.artist) == fold(song.artist))
                                                } == true
                                                YtmSongListRow(
                                                    song = song,
                                                    indexLabel = null,
                                                    inLibrary = inLib,
                                                    isActive = isActive,
                                                    isBuffering = isActive && musicState.buffering && musicState.playing,
                                                    isPlaying = isActive && musicState.playing,
                                                    onPlay = {
                                                        focusManager.clearFocus()
                                                        model.playYtmSongList(previewSongs, startIndex = idx, sourceLabel = trimmed, shuffleOn = false)
                                                    },
                                                    onSave = { model.saveYtmSongToLibrary(song) },
                                                )
                                            }
                                        }
                                    }
                                }
                                if (musicResult.albums.isNotEmpty()) {
                                    item(key = "top-music-albums") {
                                        LazyRow(
                                            contentPadding = PaddingValues(horizontal = 20.dp),
                                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                                        ) {
                                            items(musicResult.albums.take(6), key = { "top-ytm-alb-${it.browseId}" }) { alb ->
                                                YtmAlbumCard(
                                                    album = alb,
                                                    onClick = {
                                                        focusManager.clearFocus()
                                                        model.openExternalAlbum(alb.browseId, alb.title, alb.artist, alb.artUrl)
                                                    },
                                                )
                                            }
                                        }
                                    }
                                }
                            }
                            // Top 3 Creators preview
                            val showCreatorsPreview = trimmed.length >= 2 && (
                                trimmed.startsWith("@") ||
                                    creatorSuggestions.isNotEmpty() ||
                                    (creatorSuggestBusy && !hasLibraryHits)
                                )
                            if (showCreatorsPreview) {
                                item(key = "top-creators") {
                                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                        SectionHeader(
                                            title = "Creators",
                                            actionLabel = if (creatorSuggestions.isNotEmpty()) "All creators →" else null,
                                            onAction = { openScope(SearchScope.Creators) },
                                        )
                                        Column(
                                            modifier = Modifier
                                                .fillMaxWidth()
                                                .padding(horizontal = 20.dp)
                                                .clip(CardShape)
                                                .background(CardElevated)
                                                .border(0.75.dp, GlassBorder, CardShape)
                                                .padding(vertical = 4.dp),
                                        ) {
                                            if (creatorSuggestBusy && creatorSuggestions.isEmpty()) {
                                                Row(
                                                    modifier = Modifier
                                                        .fillMaxWidth()
                                                        .padding(horizontal = 14.dp, vertical = 10.dp),
                                                    verticalAlignment = Alignment.CenterVertically,
                                                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                                                ) {
                                                    CircularProgressIndicator(
                                                        color = Brand,
                                                        strokeWidth = 2.dp,
                                                        modifier = Modifier.size(16.dp),
                                                    )
                                                    Text("Finding creators…", color = Dim, fontSize = 13.sp)
                                                }
                                            } else if (creatorSuggestions.isEmpty()) {
                                                Text(
                                                    text = "No creators match \"$trimmed\".",
                                                    color = Dim,
                                                    fontSize = 13.sp,
                                                    modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
                                                )
                                            } else {
                                                creatorSuggestions.take(3).forEachIndexed { idx, suggestion ->
                                                    if (idx > 0) {
                                                        HorizontalDivider(color = Line.copy(alpha = 0.45f))
                                                    }
                                                    val matchedFollowed = findFollowedCreator(
                                                        creators = creators,
                                                        id = suggestion.id,
                                                        url = suggestion.url,
                                                        handle = suggestion.handle,
                                                        source = suggestion.source,
                                                        name = suggestion.name,
                                                    )
                                                    val alreadyFollowed = matchedFollowed != null ||
                                                        suggestion.id in followedCreatorIds ||
                                                        suggestion.url.lowercase(Locale.ROOT) in followedCreatorUrls
                                                    CreatorSuggestionRow(
                                                        suggestion = suggestion,
                                                        followed = alreadyFollowed,
                                                        busy = followBusy,
                                                        primary = idx == 0,
                                                        onFollow = { followSuggestion(suggestion) },
                                                        onUnfollow = matchedFollowed?.let { f -> { model.unfollowDiscoverCreator(f.id) } },
                                                    )
                                                }
                                            }
                                        }
                                    }
                                }
                            }

                            // Top Library hits preview
                            if (hasLibraryHits) {
                                item(key = "top-library-head") {
                                    SectionHeader(
                                        title = "In your library",
                                        actionLabel = "All library →",
                                        onAction = { openScope(SearchScope.Library) },
                                    )
                                }

                                if (matchedFilms.isNotEmpty()) {
                                    item(key = "top-films") {
                                        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                            Text(
                                                text = "Movies & TV",
                                                color = Dim,
                                                fontSize = 12.sp,
                                                fontWeight = FontWeight.SemiBold,
                                                modifier = Modifier.padding(horizontal = 20.dp),
                                            )
                                            LazyRow(
                                                modifier = Modifier.fillMaxWidth(),
                                                contentPadding = PaddingValues(horizontal = 20.dp),
                                                horizontalArrangement = Arrangement.spacedBy(12.dp),
                                            ) {
                                                items(matchedFilms.take(4), key = { "top-film-${it.key}" }) { tile ->
                                                    LibraryPosterGridCard(
                                                        tile = tile,
                                                        onOpen = { onOpenTitle(tile.key) },
                                                        onLongClick = {
                                                            haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                                                            model.openPeek(PeekTarget.LibraryTitle(tile))
                                                        },
                                                        modifier = Modifier.width(116.dp),
                                                    )
                                                }
                                            }
                                        }
                                    }
                                }

                                if (matchedAlbums.isNotEmpty()) {
                                    item(key = "top-albums") {
                                        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                            Text(
                                                text = "Albums",
                                                color = Dim,
                                                fontSize = 12.sp,
                                                fontWeight = FontWeight.SemiBold,
                                                modifier = Modifier.padding(horizontal = 20.dp),
                                            )
                                            LazyRow(
                                                modifier = Modifier.fillMaxWidth(),
                                                contentPadding = PaddingValues(horizontal = 20.dp),
                                                horizontalArrangement = Arrangement.spacedBy(12.dp),
                                            ) {
                                                items(matchedAlbums.take(4), key = { "top-alb-${it.key}" }) { album ->
                                                    AlbumShelfCard(
                                                        album = album,
                                                        onOpen = { onOpenAlbum(album.key) },
                                                        onPlay = {
                                                            val list = album.toTrackItems()
                                                            if (list.isNotEmpty()) {
                                                                model.music.playTrackList(
                                                                    list,
                                                                    0,
                                                                    album.album.ifBlank { album.title },
                                                                    shuffleOn = false,
                                                                )
                                                            }
                                                        },
                                                        onLongClick = {
                                                            haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                                                            model.openPeek(PeekTarget.LibraryAlbum(album))
                                                        },
                                                        modifier = Modifier.width(126.dp),
                                                    )
                                                }
                                            }
                                        }
                                    }
                                }

                                if (matchedTracks.isNotEmpty()) {
                                    val previewTracks = matchedTracks.take(4)
                                    item(key = "top-tracks") {
                                        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                            Text(
                                                text = "Tracks",
                                                color = Dim,
                                                fontSize = 12.sp,
                                                fontWeight = FontWeight.SemiBold,
                                                modifier = Modifier.padding(horizontal = 20.dp, vertical = 2.dp),
                                            )
                                            previewTracks.forEachIndexed { idx, row ->
                                                SearchTrackRow(
                                                    row = row,
                                                    active = row.entry.key == activeKey,
                                                    showDivider = idx < previewTracks.lastIndex,
                                                    onClick = {
                                                        model.music.playTrackList(
                                                            previewTracks.map { it.toTrackItem() },
                                                            idx,
                                                            "Search · $trimmed",
                                                        )
                                                    },
                                                )
                                            }
                                        }
                                    }
                                }

                                if (matchedClips.isNotEmpty()) {
                                    item(key = "top-clips") {
                                        Column(
                                            modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp),
                                            verticalArrangement = Arrangement.spacedBy(8.dp),
                                        ) {
                                            Text(
                                                text = "Videos",
                                                color = Dim,
                                                fontSize = 12.sp,
                                                fontWeight = FontWeight.SemiBold,
                                            )
                                            matchedClips.take(4).forEach { tile ->
                                                SearchClipRow(
                                                    tile = tile,
                                                    onOpen = { onOpenTitle(tile.key) },
                                                    onLongClick = {
                                                        haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                                                        model.openPeek(PeekTarget.LibraryTitle(tile))
                                                    },
                                                )
                                            }
                                        }
                                    }
                                }
                            }

                            // Compact Sources preview when results already exist or are loading
                            if (askedSources && (sourcesCount > 0 || sourcesBusy)) {
                                item(key = "top-sources-preview") {
                                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                        SectionHeader(
                                            title = if (sourcesCount > 0) "Sources ($sourcesCount)" else "Sources",
                                            actionLabel = "See all in Sources →",
                                            onAction = { openScope(SearchScope.Sources) },
                                        )
                                        if (sourcesBusy && sourcesCount == 0) {
                                            Row(
                                                modifier = Modifier.padding(horizontal = 20.dp, vertical = 4.dp),
                                                verticalAlignment = Alignment.CenterVertically,
                                                horizontalArrangement = Arrangement.spacedBy(10.dp),
                                            ) {
                                                CircularProgressIndicator(
                                                    color = Brand,
                                                    strokeWidth = 2.dp,
                                                    modifier = Modifier.size(15.dp),
                                                )
                                                Text("Searching sources…", color = Dim, fontSize = 13.sp)
                                            }
                                        } else {
                                            Column(
                                                modifier = Modifier
                                                    .fillMaxWidth()
                                                    .padding(horizontal = 20.dp)
                                                    .clip(CardShape)
                                                    .background(CardBg)
                                                    .border(0.75.dp, GlassBorder, CardShape),
                                            ) {
                                                val previews = buildTopSourcePreviews(sourceSearch.result).take(3)
                                                previews.forEachIndexed { idx, preview ->
                                                    if (idx > 0) {
                                                        HorizontalDivider(color = Line.copy(alpha = 0.4f))
                                                    }
                                                    TopSourcePreviewRow(
                                                        preview = preview,
                                                        onAction = {
                                                            when (preview) {
                                                                is TopSourcePreview.Soulseek -> model.saveSoulseekAlbum(preview.item)
                                                                is TopSourcePreview.YouTube -> {
                                                                    val plan = smartParseYouTubeCandidate(preview.item)
                                                                    model.saveYouTubeTrack(
                                                                        candidate = preview.item,
                                                                        artist = plan.artist,
                                                                        album = plan.album.ifBlank { plan.title },
                                                                    )
                                                                }
                                                                is TopSourcePreview.SoundCloud -> model.saveSoundCloudTrack(preview.item)
                                                                is TopSourcePreview.Rumble -> model.saveRumbleItem(preview.item, audioOnly = false)
                                                            }
                                                        },
                                                        onLongClick = (preview as? TopSourcePreview.YouTube)?.let { yt ->
                                                            { pendingYouTubeSave = yt.item }
                                                        },
                                                    )
                                                }
                                            }
                                        }
                                    }
                                }
                            }

                            // Compact Relays preview when results already exist or are loading
                            if (askedRelays && (relaysCount > 0 || relaysBusy)) {
                                item(key = "top-relays-preview") {
                                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                        SectionHeader(
                                            title = if (relaysCount > 0) "Relays ($relaysCount)" else "Relays",
                                            actionLabel = "See all on Relays →",
                                            onAction = { openScope(SearchScope.Relays) },
                                        )
                                        if (relaysBusy && relaysCount == 0) {
                                            Row(
                                                modifier = Modifier.padding(horizontal = 20.dp, vertical = 4.dp),
                                                verticalAlignment = Alignment.CenterVertically,
                                                horizontalArrangement = Arrangement.spacedBy(10.dp),
                                            ) {
                                                CircularProgressIndicator(
                                                    color = Brand,
                                                    strokeWidth = 2.dp,
                                                    modifier = Modifier.size(15.dp),
                                                )
                                                Text("Asking other relays…", color = Dim, fontSize = 13.sp)
                                            }
                                        } else {
                                            Column(
                                                modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp),
                                                verticalArrangement = Arrangement.spacedBy(8.dp),
                                            ) {
                                                global.rows.take(3).forEach { row ->
                                                    RelayHitCard(
                                                        row = row,
                                                        onPlay = { model.openUriOrKey(row.magnetUrl) },
                                                    )
                                                }
                                            }
                                        }
                                    }
                                }
                            }

                            // Quiet obsidian external search prompt when no external search has run yet
                            if (!askedSources && !askedRelays && trimmed.length >= 2) {
                                if (!hasLibraryHits && creatorSuggestions.isEmpty() && !creatorSuggestBusy) {
                                    item(key = "top-no-local") {
                                        Text(
                                            text = "No matches in your library for \"$trimmed\".",
                                            color = Dim,
                                            fontSize = 13.sp,
                                            modifier = Modifier.padding(horizontal = 20.dp),
                                        )
                                    }
                                }
                                item(key = "top-external-bar") {
                                    Row(
                                        modifier = Modifier
                                            .fillMaxWidth()
                                            .padding(horizontal = 20.dp)
                                            .clip(CardShape)
                                            .background(CardElevated)
                                            .border(0.75.dp, GlassBorder, CardShape)
                                            .padding(horizontal = 14.dp, vertical = 12.dp),
                                        verticalAlignment = Alignment.CenterVertically,
                                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                                    ) {
                                        Text(
                                            text = "Search outside your library",
                                            color = Ink,
                                            fontSize = 13.sp,
                                            fontWeight = FontWeight.Medium,
                                            modifier = Modifier.weight(1f),
                                        )
                                        SearchCompactActionPill(
                                            label = "Sources",
                                            onClick = { openScope(SearchScope.Sources) },
                                        )
                                        SearchCompactActionPill(
                                            label = "Relays",
                                            onClick = { openScope(SearchScope.Relays) },
                                        )
                                    }
                                }
                            } else if (
                                !hasLibraryHits &&
                                creatorSuggestions.isEmpty() &&
                                !creatorSuggestBusy &&
                                sourcesCount == 0 &&
                                relaysCount == 0 &&
                                !sourcesBusy &&
                                !relaysBusy
                            ) {
                                item(key = "top-empty-all") {
                                    Text(
                                        text = if (trimmed.length < 2) {
                                            "Type at least two characters to search."
                                        } else {
                                            "No results found for \"$trimmed\"."
                                        },
                                        color = Dim,
                                        fontSize = 13.sp,
                                        modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp),
                                    )
                                }
                            }
                        }
                    }

                    SearchScope.Music -> {
                        LazyColumn(
                            modifier = Modifier.weight(1f).fillMaxWidth(),
                            contentPadding = PaddingValues(top = 8.dp, bottom = bottomPadding),
                            verticalArrangement = Arrangement.spacedBy(16.dp),
                        ) {
                            if (musicBusy && musicCount == 0) {
                                item(key = "music-scope-loading") {
                                    Box(
                                        modifier = Modifier.fillMaxWidth().padding(vertical = 48.dp),
                                        contentAlignment = Alignment.Center,
                                    ) {
                                        CircularProgressIndicator(color = BrandHover, strokeWidth = 2.5.dp)
                                    }
                                }
                            } else if (musicCount == 0) {
                                item(key = "music-scope-empty") {
                                    Text(
                                        text = "No music results for \"$trimmed\".",
                                        color = Dim,
                                        fontSize = 14.sp,
                                        modifier = Modifier.padding(horizontal = 20.dp, vertical = 24.dp),
                                    )
                                }
                            } else {
                                if (musicResult.artists.isNotEmpty()) {
                                    item(key = "music-scope-artists") {
                                        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                                            SectionHeader(title = "Artists")
                                            LazyRow(
                                                contentPadding = PaddingValues(horizontal = 20.dp),
                                                horizontalArrangement = Arrangement.spacedBy(14.dp),
                                            ) {
                                                items(musicResult.artists, key = { "ms-art-${it.browseId}" }) { artist ->
                                                    YtmArtistChipCard(
                                                        artist = artist,
                                                        onClick = {
                                                            focusManager.clearFocus()
                                                            model.openExternalArtist(artist.browseId, artist.name, artist.artUrl)
                                                        },
                                                    )
                                                }
                                            }
                                        }
                                    }
                                }
                                if (musicResult.songs.isNotEmpty()) {
                                    item(key = "music-scope-songs-head") {
                                        SectionHeader(title = "Songs")
                                    }
                                    itemsIndexed(musicResult.songs, key = { idx, s -> "ms-song-$idx-${s.videoId}" }) { idx, song ->
                                        val inLib = "${fold(song.artist)}|${fold(song.title)}" in ownedTrackSignatures
                                        val isActive = musicState.currentTrack?.let {
                                            it.externalVideoId == song.videoId ||
                                                (fold(it.title) == fold(song.title) && fold(it.artist) == fold(song.artist))
                                        } == true
                                        YtmSongListRow(
                                            song = song,
                                            indexLabel = null,
                                            inLibrary = inLib,
                                            isActive = isActive,
                                            isBuffering = isActive && musicState.buffering && musicState.playing,
                                            isPlaying = isActive && musicState.playing,
                                            onPlay = {
                                                focusManager.clearFocus()
                                                model.playYtmSongList(musicResult.songs, startIndex = idx, sourceLabel = trimmed, shuffleOn = false)
                                            },
                                            onSave = { model.saveYtmSongToLibrary(song) },
                                            modifier = Modifier.padding(horizontal = 20.dp),
                                        )
                                    }
                                }
                                if (musicResult.albums.isNotEmpty()) {
                                    item(key = "music-scope-albums") {
                                        YtmAlbumCarouselShelf(
                                            title = "Albums",
                                            albums = musicResult.albums,
                                            onOpenAlbum = { alb ->
                                                focusManager.clearFocus()
                                                model.openExternalAlbum(alb.browseId, alb.title, alb.artist, alb.artUrl)
                                            },
                                        )
                                    }
                                }
                            }
                        }
                    }

                    SearchScope.Library -> {
                        if (!hasLibraryHits) {
                            Box(
                                modifier = Modifier
                                    .weight(1f)
                                    .fillMaxWidth()
                                    .padding(horizontal = 28.dp),
                                contentAlignment = Alignment.Center,
                            ) {
                                Text(
                                    text = "No matches in your library for \"$trimmed\".",
                                    color = Dim,
                                    fontSize = 14.sp,
                                    textAlign = TextAlign.Center,
                                )
                            }
                        } else {
                            LazyColumn(
                                modifier = Modifier.weight(1f).fillMaxWidth(),
                                contentPadding = PaddingValues(top = 6.dp, bottom = bottomPadding),
                                verticalArrangement = Arrangement.spacedBy(18.dp),
                            ) {
                                if (matchedFilms.isNotEmpty()) {
                                    item(key = "lib-films") {
                                        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                            SectionHeader("Movies & TV (${matchedFilms.size})")
                                            LazyRow(
                                                modifier = Modifier.fillMaxWidth(),
                                                contentPadding = PaddingValues(horizontal = 20.dp),
                                                horizontalArrangement = Arrangement.spacedBy(12.dp),
                                            ) {
                                                items(matchedFilms.take(20), key = { "lf-${it.key}" }) { tile ->
                                                    LibraryPosterGridCard(
                                                        tile = tile,
                                                        onOpen = { onOpenTitle(tile.key) },
                                                        onLongClick = {
                                                            haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                                                            model.openPeek(PeekTarget.LibraryTitle(tile))
                                                        },
                                                        modifier = Modifier.width(120.dp),
                                                    )
                                                }
                                            }
                                        }
                                    }
                                }

                                if (matchedAlbums.isNotEmpty()) {
                                    item(key = "lib-albums") {
                                        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                            SectionHeader("Albums (${matchedAlbums.size})")
                                            LazyRow(
                                                modifier = Modifier.fillMaxWidth(),
                                                contentPadding = PaddingValues(horizontal = 20.dp),
                                                horizontalArrangement = Arrangement.spacedBy(12.dp),
                                            ) {
                                                items(matchedAlbums.take(20), key = { "la-${it.key}" }) { album ->
                                                    AlbumShelfCard(
                                                        album = album,
                                                        onOpen = { onOpenAlbum(album.key) },
                                                        onPlay = {
                                                            val list = album.toTrackItems()
                                                            if (list.isNotEmpty()) {
                                                                model.music.playTrackList(
                                                                    list,
                                                                    0,
                                                                    album.album.ifBlank { album.title },
                                                                    shuffleOn = false,
                                                                )
                                                            }
                                                        },
                                                        onLongClick = {
                                                            haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                                                            model.openPeek(PeekTarget.LibraryAlbum(album))
                                                        },
                                                    )
                                                }
                                            }
                                        }
                                    }
                                }

                                if (matchedTracks.isNotEmpty()) {
                                    val shownTracks = matchedTracks.take(25)
                                    item(key = "lib-tracks-head") {
                                        SectionHeader("Tracks (${matchedTracks.size})")
                                    }
                                    itemsIndexed(shownTracks, key = { idx, r -> "lt-${r.entry.key}-$idx" }) { idx, row ->
                                        SearchTrackRow(
                                            row = row,
                                            active = row.entry.key == activeKey,
                                            showDivider = idx < shownTracks.lastIndex,
                                            onClick = {
                                                model.music.playTrackList(
                                                    shownTracks.map { it.toTrackItem() },
                                                    idx,
                                                    "Search · $trimmed",
                                                )
                                            },
                                        )
                                    }
                                }

                                if (matchedClips.isNotEmpty()) {
                                    item(key = "lib-clips-head") {
                                        SectionHeader("Videos (${matchedClips.size})")
                                    }
                                    items(matchedClips.take(20), key = { "lc-${it.key}" }) { tile ->
                                        SearchClipRow(
                                            tile = tile,
                                            onOpen = { onOpenTitle(tile.key) },
                                            onLongClick = {
                                                haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                                                model.openPeek(PeekTarget.LibraryTitle(tile))
                                            },
                                            modifier = Modifier.padding(horizontal = 20.dp),
                                        )
                                    }
                                }
                            }
                        }
                    }

                    SearchScope.Creators -> {
                        when {
                            trimmed.length < 2 -> {
                                Box(
                                    modifier = Modifier.weight(1f).fillMaxWidth().padding(horizontal = 28.dp),
                                    contentAlignment = Alignment.Center,
                                ) {
                                    Text(
                                        text = "Type at least two characters to find creators.",
                                        color = Dim,
                                        fontSize = 14.sp,
                                        textAlign = TextAlign.Center,
                                    )
                                }
                            }
                            creatorSuggestBusy && creatorSuggestions.isEmpty() -> {
                                Box(
                                    modifier = Modifier.weight(1f).fillMaxWidth().padding(horizontal = 28.dp),
                                    contentAlignment = Alignment.Center,
                                ) {
                                    Row(
                                        verticalAlignment = Alignment.CenterVertically,
                                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                                    ) {
                                        CircularProgressIndicator(
                                            color = Brand,
                                            strokeWidth = 2.dp,
                                            modifier = Modifier.size(18.dp),
                                        )
                                        Text("Finding creators & channels…", color = Dim, fontSize = 14.sp)
                                    }
                                }
                            }
                            creatorSuggestions.isEmpty() -> {
                                Box(
                                    modifier = Modifier.weight(1f).fillMaxWidth().padding(horizontal = 28.dp),
                                    contentAlignment = Alignment.Center,
                                ) {
                                    Text(
                                        text = "No creators or channels found for \"$trimmed\".",
                                        color = Dim,
                                        fontSize = 14.sp,
                                        textAlign = TextAlign.Center,
                                    )
                                }
                            }
                            else -> {
                                LazyColumn(
                                    modifier = Modifier.weight(1f).fillMaxWidth(),
                                    contentPadding = PaddingValues(top = 6.dp, bottom = bottomPadding),
                                    verticalArrangement = Arrangement.spacedBy(12.dp),
                                ) {
                                    if (creatorSuggestBusy) {
                                        item(key = "creators-updating") {
                                            Row(
                                                modifier = Modifier.padding(horizontal = 20.dp),
                                                verticalAlignment = Alignment.CenterVertically,
                                                horizontalArrangement = Arrangement.spacedBy(8.dp),
                                            ) {
                                                CircularProgressIndicator(
                                                    color = Brand,
                                                    strokeWidth = 2.dp,
                                                    modifier = Modifier.size(14.dp),
                                                )
                                                Text("Searching more creators…", color = Dim, fontSize = 12.sp)
                                            }
                                        }
                                    }
                                    item(key = "creators-list") {
                                        Column(
                                            modifier = Modifier
                                                .fillMaxWidth()
                                                .padding(horizontal = 20.dp)
                                                .clip(CardShape)
                                                .background(CardElevated)
                                                .border(0.75.dp, GlassBorder, CardShape)
                                                .padding(vertical = 4.dp),
                                        ) {
                                            creatorSuggestions.take(8).forEachIndexed { idx, suggestion ->
                                                if (idx > 0) {
                                                    HorizontalDivider(color = Line.copy(alpha = 0.45f))
                                                }
                                                val matchedFollowed = findFollowedCreator(
                                                    creators = creators,
                                                    id = suggestion.id,
                                                    url = suggestion.url,
                                                    handle = suggestion.handle,
                                                    source = suggestion.source,
                                                    name = suggestion.name,
                                                )
                                                val alreadyFollowed = matchedFollowed != null ||
                                                    suggestion.id in followedCreatorIds ||
                                                    suggestion.url.lowercase(Locale.ROOT) in followedCreatorUrls
                                                CreatorSuggestionRow(
                                                    suggestion = suggestion,
                                                    followed = alreadyFollowed,
                                                    busy = followBusy,
                                                    primary = idx == 0,
                                                    onFollow = { followSuggestion(suggestion) },
                                                    onUnfollow = matchedFollowed?.let { f -> { model.unfollowDiscoverCreator(f.id) } },
                                                )
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }

                    SearchScope.Sources -> {
                        LazyColumn(
                            modifier = Modifier.weight(1f).fillMaxWidth(),
                            contentPadding = PaddingValues(top = 6.dp, bottom = bottomPadding),
                            verticalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            item(key = "sources-controls") {
                                LazyRow(
                                    modifier = Modifier.fillMaxWidth(),
                                    contentPadding = PaddingValues(horizontal = 20.dp),
                                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    items(SearchSource.entries, key = { "src-toggle-${it.name}" }) { src ->
                                        SearchSourcePill(
                                            label = src.label,
                                            selected = src in selectedSources,
                                            onClick = { model.toggleSearchSource(src) },
                                        )
                                    }
                                    if (trimmed.length >= 2 && !sourcesBusy) {
                                        item(key = "src-refresh") {
                                            SearchCompactActionPill(
                                                label = if (askedSources) "Refresh" else "Search",
                                                onClick = { model.searchSources(trimmed, selectedSources) },
                                            )
                                        }
                                    }
                                }
                            }

                            if (SearchSource.Soulseek in selectedSources && !soulseekConfigured) {
                                item(key = "sources-soulseek-hint") {
                                    Row(
                                        Modifier
                                            .fillMaxWidth()
                                            .padding(horizontal = 20.dp)
                                            .clip(CardShape)
                                            .background(CardBg)
                                            .border(0.75.dp, GlassBorder, CardShape)
                                            .padding(horizontal = 12.dp, vertical = 8.dp),
                                        verticalAlignment = Alignment.CenterVertically,
                                    ) {
                                        Text(
                                            "Sign in to Soulseek in Settings to search peer shelves.",
                                            color = Dim,
                                            fontSize = 12.sp,
                                            modifier = Modifier.weight(1f),
                                        )
                                        TextButton(onClick = { model.pushScreen(Screen.Settings) }) {
                                            Text("Settings", color = Brand, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                                        }
                                    }
                                }
                            }

                            item(key = "sources-status") {
                                Column(
                                    modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp),
                                    verticalArrangement = Arrangement.spacedBy(8.dp),
                                ) {
                                    when {
                                        trimmed.length < 2 -> Text(
                                            "Type at least two characters to search sources.",
                                            color = Dim,
                                            fontSize = 13.sp,
                                        )
                                        !askedSources -> Text(
                                            "Tap Search to query your selected sources.",
                                            color = Dim,
                                            fontSize = 13.sp,
                                        )
                                        sourceSearch.busy -> Row(
                                            verticalAlignment = Alignment.CenterVertically,
                                            horizontalArrangement = Arrangement.spacedBy(10.dp),
                                        ) {
                                            CircularProgressIndicator(
                                                color = Brand,
                                                strokeWidth = 2.dp,
                                                modifier = Modifier.size(16.dp),
                                            )
                                            Text("Searching sources…", color = Dim, fontSize = 13.sp)
                                        }
                                        sourceSearch.error != null -> Text(
                                            sourceSearch.error ?: "",
                                            color = Danger,
                                            fontSize = 13.sp,
                                        )
                                        sourceSearch.result.isEmpty && sourceSearch.result.errors.isEmpty() -> Text(
                                            "No results from the selected sources for \"$trimmed\".",
                                            color = Dim,
                                            fontSize = 13.sp,
                                        )
                                    }
                                    if (askedSources && sourceSearch.result.errors.isNotEmpty()) {
                                        sourceSearch.result.errors.forEach { (srcName, msg) ->
                                            Text(
                                                "${srcName.replaceFirstChar { it.uppercase() }}: $msg",
                                                color = Warn,
                                                fontSize = 12.sp,
                                            )
                                        }
                                    }
                                }
                            }

                            if (askedSources && sourceSearch.result.soulseek.isNotEmpty()) {
                                item(key = "src-slsk-head") {
                                    SectionHeader("Soulseek (${sourceSearch.result.soulseek.size})")
                                }
                                itemsIndexed(
                                    sourceSearch.result.soulseek.take(20),
                                    key = { idx, item -> "slsk-${item.peer}-${item.folder}-$idx" },
                                ) { _, item ->
                                    Box(Modifier.padding(horizontal = 20.dp)) {
                                        SoulseekResultCard(
                                            item = item,
                                            onSave = { model.saveSoulseekAlbum(item) },
                                            onBrowseShelf = { model.openShelf(item.peer) },
                                        )
                                    }
                                }
                            }

                            if (askedSources && sourceSearch.result.youtube.isNotEmpty()) {
                                item(key = "src-yt-head") {
                                    SectionHeader("YouTube (${sourceSearch.result.youtube.size})")
                                }
                                itemsIndexed(
                                    sourceSearch.result.youtube.take(20),
                                    key = { idx, item -> "yt-${item.videoId}-$idx" },
                                ) { _, item ->
                                    Box(Modifier.padding(horizontal = 20.dp)) {
                                        val plan = remember(item.videoId, item.title, item.channel) {
                                            smartParseYouTubeCandidate(item)
                                        }
                                        YouTubeResultCard(
                                            item = item,
                                            musicState = musicState,
                                            onStream = {
                                                model.streamFullSong(
                                                    id = "yt:${item.videoId}",
                                                    title = plan.title,
                                                    artist = plan.artist,
                                                    album = plan.album,
                                                    artUrl = "https://i.ytimg.com/vi/${item.videoId}/hqdefault.jpg",
                                                    videoId = item.videoId,
                                                    sourceLabel = "Streaming · YouTube",
                                                )
                                            },
                                            onSave = {
                                                model.saveYouTubeTrack(
                                                    candidate = item,
                                                    artist = plan.artist,
                                                    album = plan.album.ifBlank { plan.title },
                                                )
                                            },
                                            onEdit = { pendingYouTubeSave = item },
                                        )
                                    }
                                }
                            }

                            if (askedSources && sourceSearch.result.soundcloud.isNotEmpty()) {
                                item(key = "src-sc-head") {
                                    SectionHeader("SoundCloud (${sourceSearch.result.soundcloud.size})")
                                }
                                itemsIndexed(
                                    sourceSearch.result.soundcloud.take(20),
                                    key = { idx, item -> "sc-${item.trackId}-$idx" },
                                ) { _, item ->
                                    Box(Modifier.padding(horizontal = 20.dp)) {
                                        SoundCloudResultCard(
                                            item = item,
                                            onSave = { model.saveSoundCloudTrack(item) },
                                        )
                                    }
                                }
                            }

                            if (askedSources && sourceSearch.result.rumble.isNotEmpty()) {
                                item(key = "src-rmb-head") {
                                    SectionHeader("Rumble (${sourceSearch.result.rumble.size})")
                                }
                                itemsIndexed(
                                    sourceSearch.result.rumble.take(20),
                                    key = { idx, item -> "rmb-${item.rumbleId}-$idx" },
                                ) { _, item ->
                                    Box(Modifier.padding(horizontal = 20.dp)) {
                                        RumbleResultCard(
                                            item = item,
                                            onSaveVideo = { model.saveRumbleItem(item, audioOnly = false) },
                                            onSaveAudio = { model.saveRumbleItem(item, audioOnly = true) },
                                        )
                                    }
                                }
                            }
                        }
                    }

                    SearchScope.Relays -> {
                        LazyColumn(
                            modifier = Modifier.weight(1f).fillMaxWidth(),
                            contentPadding = PaddingValues(top = 6.dp, bottom = bottomPadding),
                            verticalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            item(key = "relays-header") {
                                Row(
                                    modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                                ) {
                                    Text(
                                        text = if (relaysCount > 0) "Other relays ($relaysCount)" else "Other relays",
                                        color = Ink,
                                        fontSize = 17.sp,
                                        fontWeight = FontWeight.SemiBold,
                                        letterSpacing = (-0.2).sp,
                                        modifier = Modifier.weight(1f),
                                    )
                                    if (trimmed.length >= 2 && !relaysBusy) {
                                        SearchCompactActionPill(
                                            label = if (askedRelays) "Ask again" else "Ask relays",
                                            onClick = { model.searchGlobal(trimmed) },
                                        )
                                    }
                                }
                            }

                            val statusNote = when {
                                trimmed.length < 2 -> "Type at least two characters to ask other relays."
                                !askedRelays -> "Ask other relays in the swarm for \"$trimmed\"."
                                global.error != null -> global.error
                                global.rows.isEmpty() && !global.busy -> "No relay has it yet. Answers can take a few seconds."
                                else -> null
                            }

                            if (relaysBusy) {
                                item(key = "relays-busy") {
                                    Row(
                                        modifier = Modifier.padding(horizontal = 20.dp),
                                        verticalAlignment = Alignment.CenterVertically,
                                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                                    ) {
                                        CircularProgressIndicator(
                                            color = Brand,
                                            strokeWidth = 2.dp,
                                            modifier = Modifier.size(16.dp),
                                        )
                                        Text("Searching relays…", color = Dim, fontSize = 13.sp)
                                    }
                                }
                            } else if (statusNote != null) {
                                item(key = "relays-note") {
                                    Text(
                                        text = statusNote,
                                        color = if (global.error != null) Danger else Dim,
                                        fontSize = 13.sp,
                                        modifier = Modifier.padding(horizontal = 20.dp),
                                    )
                                }
                            }

                            if (askedRelays && global.rows.isNotEmpty()) {
                                itemsIndexed(
                                    global.rows,
                                    key = { idx, row -> "relay-${row.magnetUrl}-$idx" },
                                ) { _, row ->
                                    Box(Modifier.padding(horizontal = 20.dp)) {
                                        RelayHitCard(
                                            row = row,
                                            onPlay = { model.openUriOrKey(row.magnetUrl) },
                                        )
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    pendingYouTubeSave?.let { yt ->
        YouTubeSaveDialog(
            candidate = yt,
            onDismiss = { pendingYouTubeSave = null },
            onConfirm = { artist, album, year ->
                pendingYouTubeSave = null
                model.saveYouTubeTrack(yt, artist = artist, album = album, year = year)
            },
        )
    }

    if (scanner) {
        QrScannerSheet(
            onScanned = {
                scanner = false
                if (it.startsWith("peartube:", true) || it.startsWith("http://", true) || it.startsWith("https://", true)) {
                    model.handleSharedText(it)
                } else {
                    model.pairCastByUriOrHost(it)
                }
            },
            onClose = { scanner = false },
        )
    }
}

private sealed interface TopSourcePreview {
    val title: String
    val subtitle: String
    val badge: String
    val highlightBadge: Boolean

    data class Soulseek(val item: SoulseekAlbumCandidate) : TopSourcePreview {
        override val title: String get() = item.displayTitle
        override val subtitle: String
            get() = listOfNotNull(
                item.artist.takeIf { it.isNotBlank() },
                item.peer.takeIf { it.isNotBlank() }?.let { "from $it" },
            ).joinToString(" · ").ifBlank { "Soulseek" }
        override val badge: String get() = item.quality.ifBlank { "Soulseek" }
        override val highlightBadge: Boolean get() = item.quality.startsWith("FLAC", ignoreCase = true)
    }

    data class YouTube(val item: YouTubeCandidate) : TopSourcePreview {
        override val title: String get() = item.title
        override val subtitle: String get() = item.channel.ifBlank { "YouTube" }
        override val badge: String get() = "YouTube"
        override val highlightBadge: Boolean get() = false
    }

    data class SoundCloud(val item: SoundCloudCandidate) : TopSourcePreview {
        override val title: String get() = item.title
        override val subtitle: String get() = item.artist.ifBlank { "SoundCloud" }
        override val badge: String get() = "SoundCloud"
        override val highlightBadge: Boolean get() = false
    }

    data class Rumble(val item: RumbleCandidate) : TopSourcePreview {
        override val title: String get() = item.title
        override val subtitle: String get() = item.channel.ifBlank { "Rumble" }
        override val badge: String get() = "Rumble"
        override val highlightBadge: Boolean get() = false
    }
}

private fun buildTopSourcePreviews(result: com.peartube.app.SourceSearchResult): List<TopSourcePreview> = buildList {
    result.soulseek.take(2).forEach { add(TopSourcePreview.Soulseek(it)) }
    result.youtube.take(2).forEach { add(TopSourcePreview.YouTube(it)) }
    result.soundcloud.take(2).forEach { add(TopSourcePreview.SoundCloud(it)) }
    result.rumble.take(2).forEach { add(TopSourcePreview.Rumble(it)) }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun TopSourcePreviewRow(
    preview: TopSourcePreview,
    onAction: () -> Unit,
    onLongClick: (() -> Unit)? = null,
) {
    val haptics = LocalHapticFeedback.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .then(
                if (onLongClick != null) {
                    Modifier.combinedClickable(
                        onClick = onAction,
                        onLongClick = {
                            haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                            onLongClick()
                        },
                    )
                } else {
                    Modifier
                },
            )
            .padding(horizontal = 14.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                text = preview.title,
                color = Ink,
                fontSize = 14.sp,
                fontWeight = FontWeight.Medium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                SourceBadge(text = preview.badge, highlight = preview.highlightBadge)
                Text(
                    text = preview.subtitle,
                    color = Dim,
                    fontSize = 12.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        SearchCompactActionPill(label = "Save", onClick = onAction)
    }
}

@Composable
private fun SearchScopePill(
    label: String,
    selected: Boolean,
    busy: Boolean,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .clip(PillShape)
            .background(if (selected) Pearl else GlassBg)
            .then(
                if (selected) Modifier else Modifier.border(0.75.dp, GlassBorder, PillShape),
            )
            .clickable(onClick = onClick)
            .padding(horizontal = 13.dp, vertical = 7.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(
            text = label,
            color = if (selected) PearlInk else Dim,
            fontSize = 13.sp,
            fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Medium,
            maxLines = 1,
        )
        if (busy) {
            CircularProgressIndicator(
                color = if (selected) PearlInk else Brand,
                strokeWidth = 1.5.dp,
                modifier = Modifier.size(11.dp),
            )
        }
    }
}

@Composable
private fun SearchCompactActionPill(
    label: String,
    onClick: () -> Unit,
) {
    Box(
        modifier = Modifier
            .clip(PillShape)
            .background(GlassBg)
            .border(0.75.dp, GlassBorder, PillShape)
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 6.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = label,
            color = Pearl,
            fontSize = 12.sp,
            fontWeight = FontWeight.SemiBold,
            maxLines = 1,
        )
    }
}

@Composable
private fun SearchQuickJumpChip(
    label: String,
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .clip(PillShape)
            .background(GlassBg)
            .border(0.75.dp, GlassBorder, PillShape)
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 7.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Icon(
            imageVector = icon,
            contentDescription = null,
            tint = Dim,
            modifier = Modifier.size(15.dp),
        )
        Text(
            text = label,
            color = Dim,
            fontSize = 12.sp,
            fontWeight = FontWeight.Medium,
            maxLines = 1,
        )
    }
}

@Composable
private fun SearchTrackRow(
    row: TrackRow,
    active: Boolean,
    showDivider: Boolean,
    onClick: () -> Unit,
) {
    Column(Modifier.fillMaxWidth()) {
        Row(
            Modifier
                .fillMaxWidth()
                .clickable(onClick = onClick)
                .padding(horizontal = 20.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            AlbumSleeve(
                hue = row.album.hue,
                seed = row.album.seed,
                monogramText = row.album.monogramText,
                artist = row.album.artist,
                albumName = row.albumName,
                cornerRadius = 6.dp,
                fontSize = 11.sp,
                modifier = Modifier.size(38.dp),
            )
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(
                    row.name,
                    color = if (active) Brand else Ink,
                    fontSize = 14.sp,
                    fontWeight = FontWeight.Medium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    listOfNotNull(row.artist.takeIf { it.isNotBlank() }, row.albumName).joinToString(" · "),
                    color = Dim,
                    fontSize = 12.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        if (showDivider) {
            HorizontalDivider(
                color = Line.copy(alpha = 0.4f),
                modifier = Modifier.padding(horizontal = 20.dp),
            )
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun SearchClipRow(
    tile: LibraryTile,
    onOpen: () -> Unit,
    onLongClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier
            .fillMaxWidth()
            .clip(CardShape)
            .background(CardBg)
            .border(0.75.dp, GlassBorder, CardShape)
            .combinedClickable(onClick = onOpen, onLongClick = onLongClick)
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                tile.title,
                color = Ink,
                fontSize = 15.sp,
                fontWeight = FontWeight.Medium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(tileFactsLine(tile), color = Dim, fontSize = 12.sp)
        }
        Icon(ChevronRightIcon, null, tint = Dim, modifier = Modifier.size(18.dp))
    }
}

@Composable
private fun RelayHitCard(
    row: GlobalHit,
    onPlay: () -> Unit,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .clip(CardShape)
            .background(CardBg)
            .border(0.75.dp, GlassBorder, CardShape)
            .padding(start = 14.dp, end = 6.dp, top = 8.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                row.title,
                color = Ink,
                fontSize = 14.sp,
                fontWeight = FontWeight.Medium,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                "${formatBytes(row.size)} · ${plural(row.relays, "relay", "relays")}",
                color = Dim,
                fontSize = 12.sp,
            )
        }
        TextButton(onClick = onPlay) {
            Text("Play", color = Brand, fontWeight = FontWeight.SemiBold)
        }
    }
}

@Composable
private fun SearchSourcePill(
    label: String,
    selected: Boolean,
    onClick: () -> Unit,
) {
    Box(
        modifier = Modifier
            .clip(PillShape)
            .background(if (selected) CardElevated else GlassBg)
            .border(0.75.dp, if (selected) Brand.copy(alpha = 0.65f) else GlassBorder, PillShape)
            .clickable(onClick = onClick)
            .padding(horizontal = 13.dp, vertical = 7.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = label,
            color = if (selected) Ink else Dim,
            fontSize = 12.sp,
            fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Medium,
            maxLines = 1,
        )
    }
}

@Composable
fun ShelfDetailScreen(
    model: AppModel,
    peer: String,
    onBack: () -> Unit,
) {
    val state by model.shelfState.collectAsState()
    var filter by remember { mutableStateOf("") }

    val folders = remember(state.shelf, state.peer, peer, filter) {
        val all = if (state.peer == peer) state.shelf?.folders.orEmpty() else emptyList()
        val f = filter.trim()
        if (f.isEmpty()) all
        else all.filter {
            it.displayTitle.contains(f, ignoreCase = true) ||
                it.artist.contains(f, ignoreCase = true) ||
                it.folder.contains(f, ignoreCase = true)
        }
    }

    Column(Modifier.fillMaxSize().statusBarsPadding()) {
        Row(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 4.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            CinemaIcon(BackIcon, "Back", Ink, onClick = onBack)
            Column(Modifier.weight(1f).padding(horizontal = 4.dp)) {
                Text(peer, color = Ink, fontSize = 18.sp, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                val count = if (state.peer == peer) state.shelf?.folders?.size ?: 0 else 0
                Text(
                    if (count > 0) "Soulseek shelf · ${plural(count, "folder", "folders")}" else "Soulseek shelf",
                    color = Dim,
                    fontSize = 12.sp,
                )
            }
            CinemaIcon(ReplayIcon, "Refresh shelf", Dim) { model.loadShelf(peer) }
        }
        HorizontalDivider(color = Line)

        OutlinedTextField(
            value = filter,
            onValueChange = { filter = it },
            singleLine = true,
            placeholder = { Text("Filter folders or artists", fontSize = 13.sp) },
            leadingIcon = { Icon(SearchIcon, null, tint = Dim, modifier = Modifier.size(18.dp)) },
            trailingIcon = if (filter.isNotEmpty()) {
                { CinemaIcon(CloseIcon, "Clear filter") { filter = "" } }
            } else null,
            shape = ControlShape,
            colors = fieldColors(),
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
        )

        when {
            state.busy && folders.isEmpty() -> {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        CircularProgressIndicator(color = Brand)
                        Text("Browsing $peer's shelf…", color = Dim, fontSize = 14.sp)
                    }
                }
            }
            state.error != null && folders.isEmpty() -> {
                Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Text(state.error ?: "Could not load shelf.", color = Danger, fontSize = 14.sp)
                        QuietActionButton(text = "Retry", onClick = { model.loadShelf(peer) })
                    }
                }
            }
            folders.isEmpty() -> {
                Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
                    Text(
                        if (filter.isNotBlank()) "No folder matches \"$filter\"." else "No shared folders found for $peer.",
                        color = Dim,
                        fontSize = 14.sp,
                    )
                }
            }
            else -> {
                LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    items(folders, key = { it.folder.ifBlank { "${it.artist}-${it.album}" } }) { folder ->
                        ShelfFolderCard(
                            folder = folder,
                            onSave = { model.saveSoulseekFolder(peer, folder) },
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun SoulseekResultCard(
    item: SoulseekAlbumCandidate,
    onSave: () -> Unit,
    onBrowseShelf: () -> Unit,
) {
    Column(
        Modifier
            .fillMaxWidth()
            .clip(CardShape)
            .background(CardBg)
            .border(1.dp, Line, CardShape)
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(item.displayTitle, color = Ink, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis)
                val artistLine = listOfNotNull(
                    item.artist.takeIf { it.isNotBlank() },
                    item.year.takeIf { it.isNotBlank() },
                    item.peer.takeIf { it.isNotBlank() }?.let { "from $it" },
                ).joinToString(" · ")
                if (artistLine.isNotBlank()) {
                    Text(artistLine, color = Dim, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            if (item.quality.isNotBlank()) {
                SourceBadge(text = item.quality, highlight = item.quality.startsWith("FLAC", ignoreCase = true))
            }
        }
        val facts = buildList {
            if (item.fileCount > 0) add(plural(item.fileCount, "file", "files"))
            if (item.size > 0L) add(formatBytes(item.size))
            if (item.slotsOpen == true && item.queue == 0) add("Ready now")
            else if (item.queue != null && item.queue > 0) add("Queue ${item.queue}")
        }.joinToString(" · ")
        if (facts.isNotBlank()) {
            Text(facts, color = Dim, fontSize = 12.sp)
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            PrimaryLightButton(text = "Save album", onClick = onSave)
            if (item.peer.isNotBlank()) {
                QuietActionButton(text = "Browse shelf", onClick = onBrowseShelf)
            }
        }
    }
}

@Composable
private fun ShelfFolderCard(
    folder: SoulseekShelfFolder,
    onSave: () -> Unit,
) {
    Column(
        Modifier
            .fillMaxWidth()
            .clip(CardShape)
            .background(CardBg)
            .border(1.dp, Line, CardShape)
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(folder.displayTitle, color = Ink, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis)
                if (folder.artist.isNotBlank()) {
                    Text(folder.artist, color = Dim, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            if (folder.quality.isNotBlank()) {
                SourceBadge(text = folder.quality, highlight = folder.quality.startsWith("FLAC", ignoreCase = true))
            }
        }
        val facts = buildList {
            if (folder.fileCount > 0) add(plural(folder.fileCount, "file", "files"))
            if (folder.size > 0L) add(formatBytes(folder.size))
        }.joinToString(" · ")
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(facts, color = Dim, fontSize = 12.sp, modifier = Modifier.weight(1f))
            PrimaryLightButton(text = "Save album", onClick = onSave)
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun YouTubeResultCard(
    item: YouTubeCandidate,
    musicState: MusicState,
    onStream: () -> Unit,
    onSave: () -> Unit,
    onEdit: () -> Unit,
) {
    val haptics = LocalHapticFeedback.current
    val isThis = musicState.currentTrack?.key == "ext:yt:${item.videoId}"
    val isPlaying = isThis && musicState.playing
    val isLoading = isThis && musicState.buffering && musicState.playing
    Column(
        Modifier
            .fillMaxWidth()
            .clip(CardShape)
            .background(if (isThis) Brand.copy(alpha = 0.12f) else CardBg)
            .border(1.dp, if (isThis) Brand.copy(alpha = 0.45f) else Line, CardShape)
            .combinedClickable(
                onClick = onStream,
                onLongClick = {
                    haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                    onEdit()
                },
            )
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(item.title, color = if (isThis) BrandHover else Ink, fontSize = 14.sp, fontWeight = FontWeight.Medium, maxLines = 2, overflow = TextOverflow.Ellipsis)
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            SourceBadge(text = item.qualityLabel, highlight = false)
            val meta = listOfNotNull(
                item.channel.takeIf { it.isNotBlank() },
                item.durationSec?.let { clock(it * 1000L) },
            ).joinToString(" · ")
            if (meta.isNotBlank()) {
                Text(meta, color = Dim, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            }
        }
        Row(
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                modifier = Modifier
                    .size(36.dp)
                    .clip(CircleShape)
                    .background(if (isThis) Brand else Pearl)
                    .clickable(onClick = onStream),
                contentAlignment = Alignment.Center,
            ) {
                when {
                    isLoading -> CircularProgressIndicator(
                        color = Color.White,
                        strokeWidth = 2.dp,
                        modifier = Modifier.size(16.dp),
                    )
                    isPlaying -> Icon(
                        imageVector = PauseIcon,
                        contentDescription = "Pause stream",
                        tint = Color.White,
                        modifier = Modifier.size(18.dp),
                    )
                    else -> Icon(
                        imageVector = PlayIcon,
                        contentDescription = "Stream",
                        tint = if (isThis) Color.White else PearlInk,
                        modifier = Modifier.size(18.dp),
                    )
                }
            }
            PrimaryLightButton(text = "Save", onClick = onSave)
            QuietActionButton(text = "Edit", onClick = onEdit)
        }
    }
}

@Composable
private fun SoundCloudResultCard(
    item: SoundCloudCandidate,
    onSave: () -> Unit,
) {
    Column(
        Modifier
            .fillMaxWidth()
            .clip(CardShape)
            .background(CardBg)
            .border(1.dp, Line, CardShape)
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(item.title, color = Ink, fontSize = 14.sp, fontWeight = FontWeight.Medium, maxLines = 2, overflow = TextOverflow.Ellipsis)
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            SourceBadge(text = "SoundCloud", highlight = false)
            val meta = listOfNotNull(
                item.artist.takeIf { it.isNotBlank() },
                item.durationSec?.let { clock(it * 1000L) },
            ).joinToString(" · ")
            if (meta.isNotBlank()) {
                Text(meta, color = Dim, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            }
        }
        Row {
            PrimaryLightButton(text = "Save track", onClick = onSave)
        }
    }
}

@Composable
private fun RumbleResultCard(
    item: RumbleCandidate,
    onSaveVideo: () -> Unit,
    onSaveAudio: () -> Unit,
) {
    Column(
        Modifier
            .fillMaxWidth()
            .clip(CardShape)
            .background(CardBg)
            .border(1.dp, Line, CardShape)
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(item.title, color = Ink, fontSize = 14.sp, fontWeight = FontWeight.Medium, maxLines = 2, overflow = TextOverflow.Ellipsis)
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            SourceBadge(text = "Rumble", highlight = false)
            val meta = listOfNotNull(
                item.channel.takeIf { it.isNotBlank() },
                item.durationSec?.let { clock(it * 1000L) },
            ).joinToString(" · ")
            if (meta.isNotBlank()) {
                Text(meta, color = Dim, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            PrimaryLightButton(text = "Save video", onClick = onSaveVideo)
            QuietActionButton(text = "Save audio", onClick = onSaveAudio)
        }
    }
}

@Composable
private fun SourceBadge(text: String, highlight: Boolean) {
    Box(
        Modifier
            .clip(PillShape)
            .background(if (highlight) Accent.copy(alpha = 0.16f) else CardElevated)
            .border(1.dp, if (highlight) Accent.copy(alpha = 0.45f) else Line, PillShape)
            .padding(horizontal = 9.dp, vertical = 3.dp),
    ) {
        Text(
            text = text,
            color = if (highlight) Accent else Dim,
            fontSize = 11.sp,
            fontWeight = FontWeight.SemiBold,
            maxLines = 1,
        )
    }
}

@Composable
private fun YouTubeSaveDialog(
    candidate: YouTubeCandidate,
    onDismiss: () -> Unit,
    onConfirm: (artist: String, album: String, year: String) -> Unit,
) {
    val parsed = remember(candidate.videoId) { smartParseYouTubeCandidate(candidate) }
    var artist by remember(candidate.videoId) {
        mutableStateOf(parsed.artist.ifBlank { candidate.channel.ifBlank { "YouTube" } })
    }
    var album by remember(candidate.videoId) {
        mutableStateOf(parsed.album.ifBlank { parsed.title.ifBlank { candidate.title } })
    }
    var year by remember(candidate.videoId) { mutableStateOf("") }

    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = CardElevated,
        title = { Text("Save to Listen", color = Ink) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(candidate.title, color = Dim, fontSize = 13.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
                OutlinedTextField(
                    value = artist,
                    onValueChange = { artist = it },
                    singleLine = true,
                    label = { Text("Artist") },
                    colors = fieldColors(),
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = album,
                    onValueChange = { album = it },
                    singleLine = true,
                    label = { Text("Album") },
                    colors = fieldColors(),
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = year,
                    onValueChange = { year = it },
                    singleLine = true,
                    label = { Text("Year (optional)") },
                    colors = fieldColors(),
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        },
        confirmButton = {
            TextButton(
                enabled = artist.isNotBlank() && album.isNotBlank(),
                onClick = { onConfirm(artist, album, year) },
            ) {
                Text("Save", color = Brand, fontWeight = FontWeight.SemiBold)
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text("Cancel", color = Dim)
            }
        },
    )
}
