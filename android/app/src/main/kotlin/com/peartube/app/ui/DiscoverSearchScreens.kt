package com.peartube.app.ui

import android.graphics.BitmapFactory
import android.util.LruCache
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.AssistChipDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.peartube.app.AppModel
import com.peartube.app.DiscoverCreator
import com.peartube.app.DiscoverFeedError
import com.peartube.app.DiscoverItem
import com.peartube.app.LibraryCatalog
import com.peartube.app.Room
import com.peartube.app.RumbleCandidate
import com.peartube.app.Screen
import com.peartube.app.SearchSource
import com.peartube.app.SoulseekAlbumCandidate
import com.peartube.app.SoulseekShelfFolder
import com.peartube.app.SoundCloudCandidate
import com.peartube.app.YouTubeCandidate
import com.peartube.app.findIn
import com.peartube.app.plural
import com.peartube.app.resolveLoopbackThumbUrl
import com.peartube.app.tileFactsLine
import com.peartube.app.toTrackItem
import com.peartube.app.toTrackItems
import com.peartube.shared.clock
import com.peartube.shared.formatBytes
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.net.HttpURLConnection
import java.net.URL
import java.util.Locale

private val HEX_KEY_RE = Regex("^[a-fA-F0-9]{64}$")
private val DISCOVER_TOPICS = listOf("Music", "Tech", "Science", "Podcasts", "Gaming", "Documentary")
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

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun DiscoverScreen(
    model: AppModel,
    catalog: LibraryCatalog,
) {
    val status by model.status.collectAsState()
    val entries by model.entries.collectAsState()
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

    var followInput by remember { mutableStateOf("") }
    val focusManager = LocalFocusManager.current

    val apiUrl = status?.apiUrl
    val discovered = status?.discoveredSources.orEmpty()
    val artistNames = remember(catalog.artists) {
        catalog.artists.map { it.name }.filter { it.isNotBlank() && it != "Unknown artist" }
    }
    val libraryIds = remember(entries) {
        entries.map { it.id.lowercase(Locale.ROOT) }.toSet()
    }
    val activeAcquireIds = remember(acquireJobs) {
        acquireJobs.filter { it.isActive }.map { it.id.lowercase(Locale.ROOT) }.filter { it.isNotBlank() }.toSet()
    }
    val followedCreatorIds = remember(creators) { creators.map { it.id }.toSet() }
    val followedCreatorUrls = remember(creators) { creators.map { it.url.lowercase(Locale.ROOT) }.toSet() }
    val followedCreatorKeys = remember(creators) {
        creators.map { "${it.source}:${it.name.lowercase(Locale.ROOT)}" }.toSet()
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

    val submitFollow = {
        val raw = followInput.trim()
        if (raw.isNotEmpty() && !followBusy) {
            focusManager.clearFocus()
            model.followDiscoverCreator(raw) { followInput = "" }
        }
    }

    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(18.dp),
    ) {
        item(key = "discover-header") {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    Text(
                        text = "Discover",
                        color = Ink,
                        fontSize = 22.sp,
                        fontWeight = FontWeight.Bold,
                        modifier = Modifier.weight(1f),
                    )
                    QuietActionButton(
                        text = "Search sources & relays",
                        icon = SearchIcon,
                        onClick = { model.selectRoom(Room.Search, focusSearch = true) },
                    )
                }
                Text(
                    text = "Follow creators across YouTube, SoundCloud, and Rumble, or explore topics and pull picks straight into PearTube.",
                    color = Dim,
                    fontSize = 13.sp,
                )
            }
        }

        item(key = "discover-follow-bar") {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Follow a creator", color = Ink, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    OutlinedTextField(
                        value = followInput,
                        onValueChange = { followInput = it },
                        singleLine = true,
                        enabled = !followBusy,
                        placeholder = {
                            Text(
                                "YouTube @handle, SoundCloud, or Rumble link",
                                fontSize = 13.sp,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        },
                        trailingIcon = if (followInput.isNotEmpty() && !followBusy) {
                            { CinemaIcon(CloseIcon, "Clear input") { followInput = "" } }
                        } else null,
                        keyboardOptions = KeyboardOptions(
                            capitalization = KeyboardCapitalization.None,
                            autoCorrectEnabled = false,
                            imeAction = ImeAction.Done,
                        ),
                        keyboardActions = KeyboardActions(onDone = { submitFollow() }),
                        shape = ControlShape,
                        colors = fieldColors(),
                        modifier = Modifier.weight(1f),
                    )
                    PrimaryLightButton(
                        text = if (followBusy) "…" else "Follow",
                        enabled = followInput.isNotBlank() && !followBusy,
                        onClick = submitFollow,
                    )
                }
            }
        }

        item(key = "discover-topics") {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Explore topics", color = Ink, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
                LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(DISCOVER_TOPICS, key = { "topic-$it" }) { topic ->
                        val selected = activeTopic.equals(topic, ignoreCase = true)
                        FilterChip(
                            selected = selected,
                            onClick = {
                                if (selected) model.clearDiscoverBrowse()
                                else model.browseDiscoverTopic(topic)
                            },
                            label = { Text(topic, fontSize = 13.sp) },
                            colors = FilterChipDefaults.filterChipColors(
                                containerColor = CardBg,
                                labelColor = Ink,
                                selectedContainerColor = Brand.copy(alpha = 0.24f),
                                selectedLabelColor = Ink,
                            ),
                        )
                    }
                }
            }
        }

        if (creators.isNotEmpty()) {
            item(key = "discover-creators-row") {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            text = "Creators you follow (${creators.size})",
                            color = Ink,
                            fontSize = 15.sp,
                            fontWeight = FontWeight.SemiBold,
                            modifier = Modifier.weight(1f),
                        )
                        TextButton(
                            enabled = !loading,
                            onClick = {
                                if (browsing && activeTopic != null) {
                                    model.browseDiscoverTopic(activeTopic ?: return@TextButton)
                                } else {
                                    model.loadDiscoverFeed(refresh = true)
                                }
                            },
                            contentPadding = PaddingValues(horizontal = 8.dp, vertical = 2.dp),
                        ) {
                            Icon(ReplayIcon, null, tint = Brand, modifier = Modifier.size(16.dp))
                            Spacer(Modifier.width(4.dp))
                            Text("Refresh", color = Brand, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                        }
                    }
                    LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        item(key = "creator-all") {
                            val selected = !browsing && creatorFilter.isEmpty()
                            FilterChip(
                                selected = selected,
                                onClick = { model.setDiscoverCreatorFilter("") },
                                label = { Text("All", fontSize = 12.sp) },
                                colors = FilterChipDefaults.filterChipColors(
                                    containerColor = CardBg,
                                    labelColor = Ink,
                                    selectedContainerColor = Brand.copy(alpha = 0.24f),
                                    selectedLabelColor = Ink,
                                ),
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

        item(key = "discover-source-filter") {
            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                items(DISCOVER_SOURCE_FILTERS, key = { "src-${it.first}" }) { (id, label) ->
                    val selected = sourceFilter == id
                    FilterChip(
                        selected = selected,
                        onClick = { model.setDiscoverSourceFilter(id) },
                        label = { Text(label, fontSize = 12.sp) },
                        colors = FilterChipDefaults.filterChipColors(
                            containerColor = CardBg,
                            labelColor = Dim,
                            selectedContainerColor = Brand.copy(alpha = 0.22f),
                            selectedLabelColor = Ink,
                        ),
                    )
                }
            }
        }

        if (!discoverError.isNullOrBlank()) {
            item(key = "discover-error-banner") {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(CardShape)
                        .background(Danger.copy(alpha = 0.14f))
                        .border(1.dp, Danger.copy(alpha = 0.4f), CardShape)
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
                DiscoverSoftErrorBanner(errors = shownErrors)
            }
        }

        item(key = "discover-feed-head") {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                val heading = if (browsing) {
                    "Exploring \"${activeTopic ?: ""}\""
                } else {
                    "Latest from creators"
                }
                Text(
                    text = heading,
                    color = Ink,
                    fontSize = 17.sp,
                    fontWeight = FontWeight.SemiBold,
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
                        contentPadding = PaddingValues(horizontal = 8.dp, vertical = 2.dp),
                    ) {
                        Text("Back to feed", color = Brand, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
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
                    LazyRow(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        items(browseCreators, key = { "bc-${it.id}-${it.url}" }) { bc ->
                            val alreadyFollowed = bc.followed ||
                                bc.id in followedCreatorIds ||
                                bc.url.lowercase(Locale.ROOT) in followedCreatorUrls ||
                                "${bc.source}:${bc.name.lowercase(Locale.ROOT)}" in followedCreatorKeys
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
                            )
                        }
                    }
                }
            }
        }

        when {
            loading && shownItems.isEmpty() -> {
                item(key = "discover-loading") {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(CardShape)
                            .background(CardBg)
                            .border(1.dp, Line, CardShape)
                            .padding(16.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        CircularProgressIndicator(color = Brand, strokeWidth = 2.dp, modifier = Modifier.size(18.dp))
                        Text(
                            text = if (browsing) "Browsing \"${activeTopic ?: ""}\"…" else "Refreshing your creator feed…",
                            color = Dim,
                            fontSize = 13.sp,
                        )
                    }
                }
            }
            !browsing && creators.isEmpty() -> {
                item(key = "discover-empty-creators") {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(CardShape)
                            .background(CardBg)
                            .border(1.dp, Line, CardShape)
                            .padding(16.dp),
                        verticalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        Text("Your creator feed is empty", color = Ink, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
                        Text(
                            "Paste a YouTube @handle, SoundCloud artist, or Rumble channel link above — or tap a topic chip to browse and follow creators.",
                            color = Dim,
                            fontSize = 13.sp,
                        )
                    }
                }
            }
            shownItems.isEmpty() -> {
                item(key = "discover-empty-items") {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(CardShape)
                            .background(CardBg)
                            .border(1.dp, Line, CardShape)
                            .padding(16.dp),
                        verticalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        Text(
                            text = if (browsing) "No results for \"${activeTopic ?: ""}\"." else "No recent items match this filter.",
                            color = Dim,
                            fontSize = 13.sp,
                        )
                    }
                }
            }
            else -> {
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
                    )
                }
            }
        }

        if (visitedShelves.isNotEmpty()) {
            item(key = "discover-shelves") {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    HorizontalDivider(color = Line.copy(alpha = 0.6f))
                    Text("Shelves you visited", color = Ink, fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
                    visitedShelves.forEach { shelf ->
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .clip(CardShape)
                                .background(CardBg)
                                .border(1.dp, Line, CardShape)
                                .clickable { model.openShelf(shelf.peer) }
                                .padding(horizontal = 14.dp, vertical = 12.dp),
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

        item(key = "discover-network") {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                HorizontalDivider(color = Line.copy(alpha = 0.6f))
                Text("Channels on your network", color = Ink, fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
                if (discovered.isEmpty()) {
                    Text("No channels announced on your Wi-Fi right now.", color = Dim, fontSize = 13.sp)
                } else {
                    discovered.forEach { found ->
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .clip(CardShape)
                                .background(CardBg)
                                .border(1.dp, Line, CardShape)
                                .padding(horizontal = 14.dp, vertical = 12.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(Modifier.weight(1f)) {
                                Text(found.title.ifBlank { "Channel ${found.key.take(8)}" }, color = Ink, fontSize = 15.sp, fontWeight = FontWeight.Medium)
                                if (found.via.isNotBlank()) {
                                    Text(found.via, color = Dim, fontSize = 12.sp)
                                }
                            }
                            TextButton(onClick = { model.subscribeDiscovered(found) }) {
                                Text("Follow", color = Brand, fontWeight = FontWeight.SemiBold)
                            }
                        }
                    }
                }
            }
        }

        if (artistNames.isNotEmpty()) {
            item(key = "discover-artists") {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    HorizontalDivider(color = Line.copy(alpha = 0.6f))
                    Text("More from artists you have", color = Ink, fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
                    FlowRow(
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        artistNames.take(24).forEach { name ->
                            AssistChip(
                                onClick = { model.openSearchFor(name, askRelays = true) },
                                label = { Text(name, color = Ink, fontSize = 13.sp) },
                                colors = AssistChipDefaults.assistChipColors(containerColor = CardBg),
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun DiscoverCreatorChip(
    creator: DiscoverCreator,
    apiUrl: String?,
    selected: Boolean,
    onSelect: () -> Unit,
    onUnfollow: () -> Unit,
) {
    Row(
        modifier = Modifier
            .clip(PillShape)
            .background(if (selected) Brand.copy(alpha = 0.24f) else CardBg)
            .border(1.dp, if (selected) Brand else Line, PillShape)
            .clickable(onClick = onSelect)
            .padding(start = 6.dp, end = 6.dp, top = 5.dp, bottom = 5.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        LoopbackAvatar(
            apiUrl = apiUrl,
            path = creator.avatar,
            name = creator.displayName,
            source = creator.source,
            modifier = Modifier.size(22.dp),
        )
        Text(
            text = creator.displayName,
            color = Ink,
            fontSize = 12.sp,
            fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Medium,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        Box(
            modifier = Modifier
                .size(22.dp)
                .clip(CircleShape)
                .clickable(onClick = onUnfollow),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                imageVector = CloseIcon,
                contentDescription = "Unfollow ${creator.displayName}",
                tint = Dim,
                modifier = Modifier.size(14.dp),
            )
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
            SourceBadge(text = "Following", highlight = true)
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
private fun DiscoverSoftErrorBanner(errors: List<DiscoverFeedError>) {
    Column(
        modifier = Modifier
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
) {
    val sourceColor = sourceAccentColor(item.source)
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(CardShape)
            .background(CardBg)
            .border(1.dp, Line, CardShape),
    ) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(176.dp),
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
                    .background(Bg.copy(alpha = 0.82f))
                    .border(1.dp, sourceColor.copy(alpha = 0.55f), PillShape)
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
                        .background(Bg.copy(alpha = 0.86f))
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

        Column(
            modifier = Modifier.padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
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
                                .clip(ControlShape)
                                .background(Accent.copy(alpha = 0.16f))
                                .border(1.dp, Accent.copy(alpha = 0.45f), ControlShape)
                                .padding(horizontal = 12.dp, vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(6.dp),
                        ) {
                            Icon(CheckIcon, null, tint = Accent, modifier = Modifier.size(16.dp))
                            Text("In library", color = Accent, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                        }
                    }
                    isAdding -> {
                        Row(
                            modifier = Modifier
                                .clip(ControlShape)
                                .background(CardElevated)
                                .border(1.dp, Line, ControlShape)
                                .padding(horizontal = 12.dp, vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            CircularProgressIndicator(color = Brand, strokeWidth = 2.dp, modifier = Modifier.size(14.dp))
                            Text("Adding…", color = Ink, fontSize = 13.sp, fontWeight = FontWeight.Medium)
                        }
                    }
                    else -> {
                        PrimaryLightButton(
                            text = "Add to PearTube",
                            icon = AddIcon,
                            onClick = onAdd,
                        )
                    }
                }

                if (!item.audioOnly && !isAdding) {
                    QuietActionButton(
                        text = "Audio",
                        icon = AudioIcon,
                        onClick = onAddAudio,
                    )
                }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun SearchScreen(
    model: AppModel,
    catalog: LibraryCatalog,
    onOpenAlbum: (String) -> Unit,
    onOpenTitle: (String) -> Unit,
) {
    val query by model.query.collectAsState()
    val global by model.global.collectAsState()
    val sourceSearch by model.sourceSearch.collectAsState()
    val selectedSources by model.selectedSources.collectAsState()
    val soulseekSettings by model.soulseekSettings.collectAsState()
    val plugins by model.plugins.collectAsState()
    val autoFocus by model.searchAutoFocus.collectAsState()
    val musicState by model.musicState.collectAsState()
    var scanner by remember { mutableStateOf(false) }
    var pendingYouTubeSave by remember { mutableStateOf<YouTubeCandidate?>(null) }

    val focusRequester = remember { FocusRequester() }
    val focusManager = LocalFocusManager.current

    androidx.compose.runtime.LaunchedEffect(autoFocus) {
        if (autoFocus) {
            runCatching { focusRequester.requestFocus() }
            model.searchAutoFocus.value = false
        }
    }

    val trimmed = query.trim()
    val isLink = trimmed.startsWith("peartube://", ignoreCase = true) ||
        trimmed.startsWith("http://", ignoreCase = true) ||
        trimmed.startsWith("https://", ignoreCase = true) ||
        HEX_KEY_RE.matches(trimmed)

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

    val soulseekPlugin = remember(plugins) { plugins.firstOrNull { it.name.equals("soulseek", ignoreCase = true) } }
    val soulseekConfigured = soulseekSettings.isConfigured || (soulseekPlugin?.configured == true)

    val submit = {
        if (isLink) {
            model.handleSharedText(trimmed)
            model.query.value = ""
        } else if (trimmed.length >= 2) {
            model.searchAll(trimmed)
        }
        focusManager.clearFocus()
    }

    val sampleArtists = remember(catalog.artists) {
        catalog.artists.map { it.name }.filter { it.isNotBlank() && it != "Unknown artist" }.take(8)
    }

    Column(Modifier.fillMaxSize()) {
        OutlinedTextField(
            value = query,
            onValueChange = { model.query.value = it },
            singleLine = true,
            label = { Text("Search") },
            placeholder = { Text("Blue Train, artist, or link", fontSize = 14.sp) },
            leadingIcon = { Icon(SearchIcon, null, tint = Dim, modifier = Modifier.size(20.dp)) },
            trailingIcon = {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    if (query.isNotEmpty()) CinemaIcon(CloseIcon, "Clear search") { model.query.value = "" }
                    CinemaIcon(QrCodeScannerIcon, "Scan QR code") { scanner = true }
                }
            },
            keyboardOptions = KeyboardOptions(
                capitalization = KeyboardCapitalization.None,
                autoCorrectEnabled = false,
                imeAction = ImeAction.Search,
            ),
            keyboardActions = KeyboardActions(onSearch = { submit() }),
            shape = ControlShape,
            colors = fieldColors(),
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 8.dp)
                .focusRequester(focusRequester),
        )

        if (isLink) {
            Row(
                Modifier
                    .padding(horizontal = 16.dp, vertical = 4.dp)
                    .fillMaxWidth()
                    .clip(CardShape)
                    .background(CardElevated)
                    .border(1.dp, Line, CardShape)
                    .padding(horizontal = 14.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("This is a link.", color = Ink, fontSize = 14.sp, modifier = Modifier.weight(1f))
                PrimaryLightButton("Add to library", onClick = submit)
            }
        }

        if (trimmed.isEmpty()) {
            Column(
                Modifier.fillMaxSize().padding(horizontal = 16.dp, vertical = 20.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Text("Search your library, your sources, and other relays", color = Dim, fontSize = 14.sp)
                FlowRow(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    SearchSource.entries.forEach { src ->
                        val selected = src in selectedSources
                        FilterChip(
                            selected = selected,
                            onClick = { model.toggleSearchSource(src) },
                            label = { Text(src.label, fontSize = 12.sp) },
                            colors = FilterChipDefaults.filterChipColors(
                                selectedContainerColor = Brand.copy(alpha = 0.22f),
                                selectedLabelColor = Ink,
                            ),
                        )
                    }
                }
                if (sampleArtists.isNotEmpty()) {
                    FlowRow(
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        sampleArtists.forEach { name ->
                            AssistChip(
                                onClick = { model.openSearchFor(name, askRelays = true) },
                                label = { Text(name, color = Ink, fontSize = 13.sp) },
                                colors = AssistChipDefaults.assistChipColors(containerColor = CardBg),
                            )
                        }
                    }
                }
            }
        } else if (!isLink) {
            val activeKey = musicState.currentTrack?.key
            LazyColumn(
                modifier = Modifier.weight(1f).fillMaxWidth(),
                contentPadding = PaddingValues(top = 8.dp, bottom = 28.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                val hasLibraryHits = matchedAlbums.isNotEmpty() || matchedTracks.isNotEmpty() || matchedFilms.isNotEmpty() || matchedClips.isNotEmpty()
                item(key = "in-library-head") {
                    Text(
                        "In your library",
                        color = Ink,
                        fontSize = 18.sp,
                        fontWeight = FontWeight.Bold,
                        modifier = Modifier.padding(horizontal = 16.dp),
                    )
                    if (!hasLibraryHits) {
                        Text(
                            "Nothing in your library matches \"$trimmed\".",
                            color = Dim,
                            fontSize = 13.sp,
                            modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp),
                        )
                    }
                }

                if (matchedAlbums.isNotEmpty()) {
                    item(key = "search-albums") {
                        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            SectionHeader("Albums (${matchedAlbums.size})")
                            LazyRow(
                                contentPadding = PaddingValues(horizontal = 16.dp),
                                horizontalArrangement = Arrangement.spacedBy(12.dp),
                            ) {
                                items(matchedAlbums.take(12), key = { it.key }) { album ->
                                    AlbumShelfCard(
                                        album = album,
                                        onOpen = { onOpenAlbum(album.key) },
                                        onPlay = {
                                            val list = album.toTrackItems()
                                            if (list.isNotEmpty()) {
                                                model.music.playTrackList(list, 0, album.album.ifBlank { album.title }, shuffleOn = false)
                                            }
                                        },
                                    )
                                }
                            }
                        }
                    }
                }

                if (matchedTracks.isNotEmpty()) {
                    val shownTracks = matchedTracks.take(12)
                    item(key = "search-tracks-head") {
                        SectionHeader("Tracks (${matchedTracks.size})")
                    }
                    itemsIndexed(shownTracks, key = { idx, r -> "st-${r.entry.key}-$idx" }) { idx, row ->
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .clickable {
                                    model.music.playTrackList(shownTracks.map { it.toTrackItem() }, idx, "Search · $trimmed")
                                }
                                .padding(horizontal = 16.dp, vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            AlbumSleeve(
                                hue = row.album.hue,
                                seed = row.album.seed,
                                monogramText = row.album.monogramText,
                                cornerRadius = 6.dp,
                                fontSize = 11.sp,
                                modifier = Modifier.size(38.dp),
                            )
                            Spacer(Modifier.width(12.dp))
                            Column(Modifier.weight(1f)) {
                                Text(
                                    row.name,
                                    color = if (row.entry.key == activeKey) Brand else Ink,
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
                        HorizontalDivider(color = Line.copy(alpha = 0.4f))
                    }
                }

                if (matchedFilms.isNotEmpty()) {
                    item(key = "search-films-head") { SectionHeader("Movies and series (${matchedFilms.size})") }
                    items(matchedFilms.take(12), key = { "sf-${it.key}" }) { tile ->
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .padding(horizontal = 16.dp)
                                .clip(CardShape)
                                .background(CardBg)
                                .border(1.dp, Line, CardShape)
                                .clickable { onOpenTitle(tile.key) }
                                .padding(horizontal = 14.dp, vertical = 12.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                Text(tile.title, color = Ink, fontSize = 15.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                Text(tileFactsLine(tile), color = Dim, fontSize = 12.sp)
                            }
                            Icon(ChevronRightIcon, null, tint = Dim, modifier = Modifier.size(18.dp))
                        }
                    }
                }

                if (matchedClips.isNotEmpty()) {
                    item(key = "search-clips-head") { SectionHeader("Clips (${matchedClips.size})") }
                    items(matchedClips.take(12), key = { "sc-${it.key}" }) { tile ->
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .padding(horizontal = 16.dp)
                                .clip(CardShape)
                                .background(CardBg)
                                .border(1.dp, Line, CardShape)
                                .clickable { onOpenTitle(tile.key) }
                                .padding(horizontal = 14.dp, vertical = 12.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                Text(tile.title, color = Ink, fontSize = 15.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                Text(tileFactsLine(tile), color = Dim, fontSize = 12.sp)
                            }
                            Icon(ChevronRightIcon, null, tint = Dim, modifier = Modifier.size(18.dp))
                        }
                    }
                }

                // From your sources (Soulseek, YouTube, SoundCloud, Rumble)
                item(key = "from-your-sources") {
                    HorizontalDivider(color = Line, modifier = Modifier.padding(top = 6.dp))
                    Column(
                        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
                        verticalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        val askedSources = sourceSearch.query == trimmed
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text("From your sources", color = Ink, fontSize = 18.sp, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
                            if (!askedSources || !sourceSearch.busy) {
                                QuietActionButton(
                                    text = "Ask your sources",
                                    onClick = { if (trimmed.length >= 2) model.searchAll(trimmed) },
                                )
                            }
                        }

                        FlowRow(
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                            verticalArrangement = Arrangement.spacedBy(6.dp),
                        ) {
                            SearchSource.entries.forEach { src ->
                                val selected = src in selectedSources
                                FilterChip(
                                    selected = selected,
                                    onClick = { model.toggleSearchSource(src) },
                                    label = { Text(src.label, fontSize = 12.sp) },
                                    colors = FilterChipDefaults.filterChipColors(
                                        selectedContainerColor = Brand.copy(alpha = 0.22f),
                                        selectedLabelColor = Ink,
                                    ),
                                )
                            }
                        }

                        if (SearchSource.Soulseek in selectedSources && !soulseekConfigured) {
                            Row(
                                Modifier
                                    .fillMaxWidth()
                                    .clip(CardShape)
                                    .background(CardBg)
                                    .border(1.dp, Line, CardShape)
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

                        when {
                            trimmed.length < 2 -> Text("Type at least two characters to search your sources.", color = Dim, fontSize = 13.sp)
                            !askedSources -> Text("Press Search or Ask your sources to look on Soulseek, YouTube, SoundCloud, and Rumble.", color = Dim, fontSize = 13.sp)
                            sourceSearch.busy -> Row(
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(10.dp),
                            ) {
                                CircularProgressIndicator(color = Brand, strokeWidth = 2.dp, modifier = Modifier.size(16.dp))
                                Text("Searching your sources…", color = Dim, fontSize = 13.sp)
                            }
                            sourceSearch.error != null -> Text(sourceSearch.error ?: "", color = Danger, fontSize = 13.sp)
                            sourceSearch.result.isEmpty && sourceSearch.result.errors.isEmpty() ->
                                Text("No results from the selected sources for \"$trimmed\".", color = Dim, fontSize = 13.sp)
                        }

                        if (askedSources && sourceSearch.result.errors.isNotEmpty()) {
                            sourceSearch.result.errors.forEach { (srcName, msg) ->
                                Text("${srcName.replaceFirstChar { it.uppercase() }}: $msg", color = Warn, fontSize = 12.sp)
                            }
                        }

                        if (askedSources && sourceSearch.result.soulseek.isNotEmpty()) {
                            Text("Soulseek (${sourceSearch.result.soulseek.size})", color = Ink, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
                            sourceSearch.result.soulseek.take(20).forEach { item ->
                                SoulseekResultCard(
                                    item = item,
                                    onSave = { model.saveSoulseekAlbum(item) },
                                    onBrowseShelf = { model.openShelf(item.peer) },
                                )
                            }
                        }

                        if (askedSources && sourceSearch.result.youtube.isNotEmpty()) {
                            Text("YouTube (${sourceSearch.result.youtube.size})", color = Ink, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
                            sourceSearch.result.youtube.take(20).forEach { item ->
                                YouTubeResultCard(
                                    item = item,
                                    onSave = { pendingYouTubeSave = item },
                                )
                            }
                        }

                        if (askedSources && sourceSearch.result.soundcloud.isNotEmpty()) {
                            Text("SoundCloud (${sourceSearch.result.soundcloud.size})", color = Ink, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
                            sourceSearch.result.soundcloud.take(20).forEach { item ->
                                SoundCloudResultCard(
                                    item = item,
                                    onSave = { model.saveSoundCloudTrack(item) },
                                )
                            }
                        }

                        if (askedSources && sourceSearch.result.rumble.isNotEmpty()) {
                            Text("Rumble (${sourceSearch.result.rumble.size})", color = Ink, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
                            sourceSearch.result.rumble.take(20).forEach { item ->
                                RumbleResultCard(
                                    item = item,
                                    onSaveVideo = { model.saveRumbleItem(item, audioOnly = false) },
                                    onSaveAudio = { model.saveRumbleItem(item, audioOnly = true) },
                                )
                            }
                        }
                    }
                }

                item(key = "global-relays") {
                    HorizontalDivider(color = Line, modifier = Modifier.padding(top = 6.dp))
                    Column(
                        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
                        verticalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        val asked = global.query == trimmed
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text("On other relays", color = Ink, fontSize = 18.sp, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
                            if (!asked || !global.busy) {
                                QuietActionButton(
                                    text = "Ask other relays",
                                    onClick = { if (trimmed.length >= 2) model.searchGlobal(trimmed) },
                                )
                            }
                        }
                        val note = when {
                            trimmed.length < 2 -> "Type at least two characters to ask other relays."
                            !asked -> "Press Search or Ask other relays to look outside your channels."
                            global.error != null -> global.error
                            global.rows.isEmpty() -> if (global.busy) "Asking other relays…" else "No relay has it yet. Answers can take a few seconds."
                            else -> null
                        }
                        if (note != null) Text(note, color = Dim, fontSize = 13.sp)
                        if (asked) {
                            global.rows.forEach { row ->
                                Row(
                                    Modifier
                                        .fillMaxWidth()
                                        .clip(CardShape)
                                        .background(CardBg)
                                        .border(1.dp, Line, CardShape)
                                        .padding(start = 14.dp, end = 6.dp, top = 8.dp, bottom = 8.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                        Text(row.title, color = Ink, fontSize = 14.sp, fontWeight = FontWeight.Medium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                                        Text(
                                            "${formatBytes(row.size)} · ${plural(row.relays, "relay", "relays")}",
                                            color = Dim,
                                            fontSize = 12.sp,
                                        )
                                    }
                                    TextButton(onClick = { model.openUriOrKey(row.magnetUrl) }) {
                                        Text("Play", color = Brand, fontWeight = FontWeight.SemiBold)
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

@Composable
private fun YouTubeResultCard(
    item: YouTubeCandidate,
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
            SourceBadge(text = item.qualityLabel, highlight = false)
            val meta = listOfNotNull(
                item.channel.takeIf { it.isNotBlank() },
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
    var artist by remember(candidate.videoId) { mutableStateOf(candidate.channel.ifBlank { "YouTube" }) }
    var album by remember(candidate.videoId) { mutableStateOf(candidate.title) }
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
