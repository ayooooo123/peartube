package com.peartube.app.ui

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.peartube.app.AppModel
import com.peartube.app.PodcastImportFormat
import com.peartube.app.ShareImportMode
import com.peartube.shared.formatBytes
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun SettingsScreen(model: AppModel) {
    val settings by model.settings.collectAsState()
    val status by model.status.collectAsState()
    val shareImportMode by model.shareImportMode.collectAsState()
    val podcastImportFormat by model.podcastImportFormat.collectAsState()
    var tracker by rememberSaveable { mutableStateOf(settings.tracker) }
    var sources by rememberSaveable { mutableStateOf(settings.sources.joinToString("\n") { it.key }) }
    var mnemonic by rememberSaveable { mutableStateOf(settings.mnemonic) }
    var relays by rememberSaveable { mutableStateOf(settings.relayThrough.joinToString(", ")) }
    var bootstrap by rememberSaveable { mutableStateOf(settings.bootstrap.joinToString(", ")) }
    var lan by rememberSaveable { mutableStateOf(settings.lanDiscovery) }
    var privateRouting by rememberSaveable { mutableStateOf(settings.privateRouting) }
    var cacheMaxGb by rememberSaveable { mutableStateOf(settings.cacheMaxGb) }
    var problem by remember { mutableStateOf<String?>(null) }
    var editChannels by rememberSaveable { mutableStateOf(false) }
    var advanced by rememberSaveable { mutableStateOf(false) }

    val bankSelected by model.soundFontSelected.collectAsState()
    val bankBusy by model.soundFontBusy.collectAsState()
    val bankError by model.soundFontError.collectAsState()
    val soulseek by model.soulseekSettings.collectAsState()
    val soulseekBusy by model.soulseekBusy.collectAsState()
    val soulseekError by model.soulseekError.collectAsState()
    val soulseekMessage by model.soulseekMessage.collectAsState()
    val metaState by model.metaSourcesState.collectAsState()
    val metaBusy by model.metaBusy.collectAsState()
    val metaError by model.metaError.collectAsState()
    val metaMessage by model.metaMessage.collectAsState()
    var metaInput by rememberSaveable { mutableStateOf("") }
    val plugins by model.plugins.collectAsState()
    var slskUser by rememberSaveable { mutableStateOf(soulseek.username) }
    var slskPass by rememberSaveable { mutableStateOf("") }
    var slskShare by rememberSaveable { mutableStateOf(soulseek.sharePublicMusic) }
    var slskInitialized by remember { mutableStateOf(false) }

    val scope = rememberCoroutineScope()

    LaunchedEffect(Unit) {
        model.refreshSoulseekSettings()
        model.refreshMetaSources()
    }
    LaunchedEffect(soulseek) {
        if (!slskInitialized || (slskUser.isEmpty() && soulseek.username.isNotEmpty())) {
            slskUser = soulseek.username
            slskShare = soulseek.sharePublicMusic
            slskInitialized = true
        }
    }
    val slskPlugin = remember(plugins) { plugins.firstOrNull { it.name.equals("soulseek", ignoreCase = true) } }
    // Providers often label SF2 as application/octet-stream, so any type; the import checks the file.
    val pickBank = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        uri?.let(model::importSoundFont)
    }

    fun saveSettings() {
        scope.launch {
            problem = try {
                val currentMetaSources = if (metaState.sources.isNotEmpty()) {
                    metaState.sources.map { it.key }.filter { it.isNotBlank() }
                } else {
                    settings.metaSources
                }
                val currentP2pOnly = metaState.p2pOnlyMetadata
                val currentSeedFull = metaState.seedFullMetadata
                val raw = JSONObject()
                    .put("tracker", tracker)
                    .put("sources", sources)
                    .put("mnemonic", mnemonic)
                    .put("relayThrough", relays)
                    .put("bootstrap", bootstrap)
                    .put("lanDiscovery", lan)
                    .put("privateRouting", privateRouting)
                    .put("cacheMaxGb", cacheMaxGb)
                    .put("metaSources", JSONArray(currentMetaSources))
                    .put("p2pOnlyMetadata", currentP2pOnly)
                    .put("seedFullMetadata", currentSeedFull)
                val normalized = model.worker.normalizeSettings(raw, requireChannel = false)
                val merged = normalized.copy(
                    metaSources = if (normalized.metaSources.isNotEmpty()) normalized.metaSources else currentMetaSources,
                    p2pOnlyMetadata = normalized.p2pOnlyMetadata || currentP2pOnly,
                    seedFullMetadata = normalized.seedFullMetadata || currentSeedFull,
                )
                model.save(merged)
                null
            } catch (e: Exception) {
                e.message
            }
        }
    }

    Column(
        Modifier
            .fillMaxSize()
            .background(Bg)
            .statusBarsPadding()
            .navigationBarsPadding(),
    ) {
        // LUMEN top bar: Circular Back + bold Settings + Pearl Save pill
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 20.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Box(
                modifier = Modifier
                    .size(38.dp)
                    .clip(CircleShape)
                    .background(GlassBg)
                    .border(0.75.dp, GlassBorder, CircleShape)
                    .semantics { contentDescription = "Back" }
                    .clickable { model.popScreen() },
                contentAlignment = Alignment.Center,
            ) {
                Icon(BackIcon, null, tint = Ink, modifier = Modifier.size(19.dp))
            }
            Text(
                text = "Settings",
                fontSize = 24.sp,
                fontWeight = FontWeight.Bold,
                letterSpacing = (-0.6).sp,
                color = Ink,
                modifier = Modifier.weight(1f),
            )
            Box(
                modifier = Modifier
                    .height(36.dp)
                    .clip(PillShape)
                    .background(Pearl)
                    .clickable { saveSettings() }
                    .padding(horizontal = 18.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = "Save",
                    color = PearlInk,
                    fontSize = 13.5.sp,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                )
            }
        }

        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            problem?.let { err ->
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(CardShape)
                        .background(Danger.copy(alpha = 0.14f))
                        .border(0.75.dp, Danger.copy(alpha = 0.45f), CardShape)
                        .padding(horizontal = 14.dp, vertical = 10.dp),
                ) {
                    Text(err, color = Danger, fontSize = 13.sp)
                }
            }

            // Card 1 — Channels & Account
            SettingsGroupCard {
                Text("Channels & Account", color = Ink, fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
                if (settings.sources.isEmpty()) {
                    Text("No channels followed yet", color = Dim, fontSize = 13.sp)
                } else {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        settings.sources.forEach { source ->
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clip(ControlShape)
                                    .background(CardElevated)
                                    .border(0.5.dp, GlassBorder, ControlShape)
                                    .padding(horizontal = 12.dp, vertical = 10.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(10.dp),
                            ) {
                                Text(
                                    text = source.alias.ifBlank { "Channel ${source.key.take(8)}" },
                                    color = Ink,
                                    fontSize = 14.sp,
                                    fontWeight = FontWeight.Medium,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                    modifier = Modifier.weight(1f),
                                )
                                Text(
                                    text = "${source.key.take(12)}…",
                                    color = Dim,
                                    fontSize = 11.5.sp,
                                    fontFamily = FontFamily.Monospace,
                                    maxLines = 1,
                                )
                            }
                        }
                    }
                }

                HorizontalDivider(color = Line.copy(alpha = 0.55f))

                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(ControlShape)
                        .clickable { editChannels = !editChannels }
                        .padding(vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        text = "Edit channel keys & recovery phrase",
                        color = Ink,
                        fontSize = 14.sp,
                        fontWeight = FontWeight.Medium,
                        modifier = Modifier.weight(1f),
                    )
                    Icon(
                        imageVector = if (editChannels) ChevronDownIcon else ChevronRightIcon,
                        contentDescription = null,
                        tint = Dim,
                        modifier = Modifier.size(18.dp),
                    )
                }

                AnimatedVisibility(editChannels) {
                    Column(
                        modifier = Modifier.padding(top = 6.dp),
                        verticalArrangement = Arrangement.spacedBy(14.dp),
                    ) {
                        Field(
                            "Primary channel key (optional)",
                            "64-character channel key to connect directly. Leave empty if following channels below or linking with your 12-word phrase.",
                        ) {
                            KeyField(tracker, singleLine = true) { tracker = it }
                        }
                        Field(
                            "Follow channels",
                            "One peartube://channel/… link per line. Your library brings them together.",
                        ) {
                            KeyField(sources, singleLine = false) { sources = it }
                        }
                        Field(
                            "12-word recovery phrase (link account)",
                            "Optional: paste your 12-word recovery phrase to link this phone as an owner device on your channel.",
                        ) {
                            KeyField(mnemonic, singleLine = false) { mnemonic = it }
                        }
                    }
                }
            }

            // Card 2 — Soulseek Music Network
            SettingsGroupCard {
                val connectedUser = slskPlugin?.user?.takeIf { it.isNotBlank() } ?: soulseek.username
                val isConnected = (slskPlugin?.connected == true || soulseek.isConfigured) && connectedUser.isNotBlank()
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Text("Soulseek", color = Ink, fontSize = 17.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                    Row(
                        modifier = Modifier
                            .clip(PillShape)
                            .background(if (isConnected) Accent.copy(alpha = 0.14f) else GlassBg)
                            .border(
                                width = 0.75.dp,
                                color = if (isConnected) Accent.copy(alpha = 0.45f) else GlassBorder,
                                shape = PillShape,
                            )
                            .padding(horizontal = 10.dp, vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        Box(
                            modifier = Modifier
                                .size(6.dp)
                                .clip(CircleShape)
                                .background(if (isConnected) Accent else Dim),
                        )
                        Text(
                            text = if (isConnected) "Connected as $connectedUser" else "Not signed in",
                            color = if (isConnected) Accent else Dim,
                            fontSize = 11.5.sp,
                            fontWeight = FontWeight.Medium,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
                OutlinedTextField(
                    value = slskUser,
                    onValueChange = { slskUser = it },
                    singleLine = true,
                    label = { Text("Username") },
                    keyboardOptions = KeyboardOptions(
                        capitalization = KeyboardCapitalization.None,
                        autoCorrectEnabled = false,
                    ),
                    shape = CardShape,
                    colors = fieldColors(),
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = slskPass,
                    onValueChange = { slskPass = it },
                    singleLine = true,
                    label = { Text("Password") },
                    placeholder = { Text(if (soulseek.passwordSet) "Saved on this device" else "Enter password") },
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(
                        capitalization = KeyboardCapitalization.None,
                        autoCorrectEnabled = false,
                        keyboardType = KeyboardType.Password,
                    ),
                    shape = CardShape,
                    colors = fieldColors(),
                    modifier = Modifier.fillMaxWidth(),
                )
                Row(
                    Modifier
                        .fillMaxWidth()
                        .toggleable(value = slskShare, role = Role.Switch, onValueChange = { slskShare = it }),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text("Share public music", color = Ink, fontSize = 14.5.sp, fontWeight = FontWeight.Medium)
                        Hint("Offer public albums in your library to Soulseek peers.")
                    }
                    Switch(checked = slskShare, onCheckedChange = null, colors = SwitchDefaults.colors(checkedTrackColor = Brand))
                }
                soulseekError?.let { Text(it, color = Danger, fontSize = 13.sp) }
                soulseekMessage?.let { Text(it, color = Accent, fontSize = 13.sp) }
                HeroPrimaryButton(
                    text = if (soulseekBusy) "Saving…" else "Save Soulseek",
                    enabled = !soulseekBusy,
                    shape = PillShape,
                    onClick = {
                        model.saveSoulseekSettings(
                            username = slskUser,
                            password = slskPass.takeIf { it.isNotEmpty() },
                            sharePublicMusic = slskShare,
                        )
                        slskPass = ""
                    },
                    modifier = Modifier.fillMaxWidth().height(44.dp),
                )
            }

            // Card 3 — P2P Metadata & Artwork
            SettingsGroupCard {
                val forcedByPrivate = settings.privateRouting || privateRouting
                val effectiveP2pOnly = forcedByPrivate || metaState.p2pOnlyMetadata
                val sourceCount = metaState.sources.size
                val pillLabel = when {
                    effectiveP2pOnly && sourceCount > 0 -> "P2P only · $sourceCount"
                    effectiveP2pOnly -> "P2P only"
                    sourceCount == 1 -> "1 source"
                    sourceCount > 1 -> "$sourceCount sources"
                    else -> "Fallback active"
                }
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Text(
                        text = "P2P Metadata & Artwork",
                        color = Ink,
                        fontSize = 17.sp,
                        fontWeight = FontWeight.SemiBold,
                        modifier = Modifier.weight(1f),
                    )
                    Row(
                        modifier = Modifier
                            .clip(PillShape)
                            .background(if (sourceCount > 0 || effectiveP2pOnly) Accent.copy(alpha = 0.14f) else GlassBg)
                            .border(
                                width = 0.75.dp,
                                color = if (sourceCount > 0 || effectiveP2pOnly) Accent.copy(alpha = 0.45f) else GlassBorder,
                                shape = PillShape,
                            )
                            .padding(horizontal = 10.dp, vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        Box(
                            modifier = Modifier
                                .size(6.dp)
                                .clip(CircleShape)
                                .background(if (sourceCount > 0 || effectiveP2pOnly) Accent else Dim),
                        )
                        Text(
                            text = pillLabel,
                            color = if (sourceCount > 0 || effectiveP2pOnly) Accent else Dim,
                            fontSize = 11.5.sp,
                            fontWeight = FontWeight.Medium,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }

                if (metaState.sources.isEmpty()) {
                    Text("No P2P metadata sources added yet", color = Dim, fontSize = 13.sp)
                } else {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        metaState.sources.forEach { src ->
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clip(ControlShape)
                                    .background(CardElevated)
                                    .border(0.5.dp, GlassBorder, ControlShape)
                                    .padding(horizontal = 12.dp, vertical = 10.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(10.dp),
                            ) {
                                Column(
                                    modifier = Modifier.weight(1f),
                                    verticalArrangement = Arrangement.spacedBy(2.dp),
                                ) {
                                    Text(
                                        text = src.alias.ifBlank { "Metadata ${src.key.take(8)}" },
                                        color = Ink,
                                        fontSize = 14.sp,
                                        fontWeight = FontWeight.Medium,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                    Text(
                                        text = "peartube://meta/${src.key.take(12)}…",
                                        color = Dim,
                                        fontSize = 11.5.sp,
                                        fontFamily = FontFamily.Monospace,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                }
                                Box(
                                    modifier = Modifier
                                        .clip(PillShape)
                                        .background(GlassBg)
                                        .border(0.75.dp, GlassBorder, PillShape)
                                        .clickable(enabled = !metaBusy) { model.removeMetaSource(src.key) }
                                        .padding(horizontal = 12.dp, vertical = 6.dp),
                                    contentAlignment = Alignment.Center,
                                ) {
                                    Text(
                                        text = "Remove",
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

                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    OutlinedTextField(
                        value = metaInput,
                        onValueChange = { metaInput = it },
                        singleLine = true,
                        label = { Text("peartube://meta/… or 64-hex key") },
                        keyboardOptions = KeyboardOptions(
                            capitalization = KeyboardCapitalization.None,
                            autoCorrectEnabled = false,
                        ),
                        shape = CardShape,
                        colors = fieldColors(),
                        modifier = Modifier.weight(1f),
                    )
                    Box(
                        modifier = Modifier
                            .height(48.dp)
                            .clip(PillShape)
                            .background(if (!metaBusy && metaInput.isNotBlank()) Pearl else GlassBg)
                            .then(
                                if (!metaBusy && metaInput.isNotBlank()) {
                                    Modifier
                                } else {
                                    Modifier.border(0.75.dp, GlassBorder, PillShape)
                                },
                            )
                            .clickable(enabled = !metaBusy && metaInput.isNotBlank()) {
                                val toAdd = metaInput.trim()
                                metaInput = ""
                                model.addMetaSource(toAdd)
                            }
                            .padding(horizontal = 18.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            text = if (metaBusy) "…" else "Add",
                            color = if (!metaBusy && metaInput.isNotBlank()) PearlInk else Dim,
                            fontSize = 13.5.sp,
                            fontWeight = FontWeight.SemiBold,
                            maxLines = 1,
                        )
                    }
                }

                HorizontalDivider(color = Line.copy(alpha = 0.55f))

                Row(
                    Modifier
                        .fillMaxWidth()
                        .toggleable(
                            value = effectiveP2pOnly,
                            enabled = !metaBusy && !forcedByPrivate,
                            role = Role.Switch,
                            onValueChange = { model.setP2pOnlyMetadata(it) },
                        ),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text("P2P-only metadata", color = Ink, fontSize = 14.5.sp, fontWeight = FontWeight.Medium)
                        Hint(
                            if (forcedByPrivate) {
                                "Active automatically while Private DHT routing is on. Blocks all clearnet Cinemeta, Metahub, and iTunes lookups."
                            } else {
                                "Block all clearnet Cinemeta, Metahub, and iTunes lookups and resolve posters and details strictly from P2P sources."
                            },
                        )
                    }
                    Switch(
                        checked = effectiveP2pOnly,
                        onCheckedChange = null,
                        enabled = !metaBusy && !forcedByPrivate,
                        colors = SwitchDefaults.colors(checkedTrackColor = Brand),
                    )
                }

                Row(
                    Modifier
                        .fillMaxWidth()
                        .toggleable(
                            value = metaState.seedFullMetadata,
                            enabled = !metaBusy,
                            role = Role.Switch,
                            onValueChange = { model.setSeedFullMetadata(it) },
                        ),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text("Seed full metadata catalog", color = Ink, fontSize = 14.5.sp, fontWeight = FontWeight.Medium)
                        Hint("Keep the full metadata catalog and artwork cached to seed peers. Off by default on mobile so storage stays sparse.")
                    }
                    Switch(
                        checked = metaState.seedFullMetadata,
                        onCheckedChange = null,
                        enabled = !metaBusy,
                        colors = SwitchDefaults.colors(checkedTrackColor = Brand),
                    )
                }

                metaError?.let { Text(it, color = Danger, fontSize = 13.sp) }
                metaMessage?.let { Text(it, color = Accent, fontSize = 13.sp) }
            }

            // Card 3 — Smart Sharing & Imports
            SettingsGroupCard {
                Text("Smart Sharing & Imports", color = Ink, fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
                Hint("Music links auto-detect artist & save as audio. Podcasts follow your preference below.")
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Shared links", color = Ink, fontSize = 14.sp, fontWeight = FontWeight.Medium)
                    FlowRow(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        ShareImportMode.entries.forEach { mode ->
                            val selected = shareImportMode == mode
                            Box(
                                modifier = Modifier
                                    .clip(PillShape)
                                    .background(if (selected) Pearl else GlassBg)
                                    .then(
                                        if (selected) Modifier else Modifier.border(0.75.dp, GlassBorder, PillShape),
                                    )
                                    .clickable { model.setShareImportMode(mode) }
                                    .padding(horizontal = 14.dp, vertical = 8.dp),
                                contentAlignment = Alignment.Center,
                            ) {
                                Text(
                                    text = mode.label,
                                    color = if (selected) PearlInk else Dim,
                                    fontSize = 12.5.sp,
                                    fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Medium,
                                    maxLines = 1,
                                )
                            }
                        }
                    }
                }
                HorizontalDivider(color = Line.copy(alpha = 0.55f))
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Podcasts & long talks", color = Ink, fontSize = 14.sp, fontWeight = FontWeight.Medium)
                    FlowRow(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        PodcastImportFormat.entries.forEach { format ->
                            val selected = podcastImportFormat == format
                            Box(
                                modifier = Modifier
                                    .clip(PillShape)
                                    .background(if (selected) Pearl else GlassBg)
                                    .then(
                                        if (selected) Modifier else Modifier.border(0.75.dp, GlassBorder, PillShape),
                                    )
                                    .clickable { model.setPodcastImportFormat(format) }
                                    .padding(horizontal = 14.dp, vertical = 8.dp),
                                contentAlignment = Alignment.Center,
                            ) {
                                Text(
                                    text = format.label,
                                    color = if (selected) PearlInk else Dim,
                                    fontSize = 12.5.sp,
                                    fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Medium,
                                    maxLines = 1,
                                )
                            }
                        }
                    }
                }
            }

            // Card 4 — Storage & Cache
            SettingsGroupCard {
                val choices = listOf(5, 10, 25, 50, 100, 0)
                val cachedBytes = status?.cachedBytes ?: 0L
                val usageText = when {
                    cachedBytes <= 0L -> "No cached files yet"
                    cacheMaxGb == 0 -> "${formatBytes(cachedBytes)} cached · Unlimited"
                    else -> "${formatBytes(cachedBytes)} of $cacheMaxGb GB"
                }
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Text("Storage & Cache", color = Ink, fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
                    Text(usageText, color = Dim, fontSize = 12.5.sp, fontWeight = FontWeight.Medium)
                }
                if (cacheMaxGb > 0) {
                    val limitBytes = cacheMaxGb.toLong() * 1_000_000_000L
                    val progress = (cachedBytes.toFloat() / limitBytes.toFloat()).coerceIn(0f, 1f)
                    LinearProgressIndicator(
                        progress = { progress },
                        color = Pearl,
                        trackColor = GlassBorder,
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(4.dp)
                            .clip(PillShape),
                    )
                }
                Hint("How much playback cache this phone keeps to help the swarm. The title you are watching always keeps a window around the playhead.")
                FlowRow(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    choices.forEach { gb ->
                        val selected = cacheMaxGb == gb
                        Box(
                            modifier = Modifier
                                .clip(PillShape)
                                .background(if (selected) Pearl else GlassBg)
                                .then(
                                    if (selected) Modifier else Modifier.border(0.75.dp, GlassBorder, PillShape),
                                )
                                .clickable {
                                    cacheMaxGb = gb
                                    model.setCacheLimit(gb)
                                }
                                .padding(horizontal = 14.dp, vertical = 8.dp),
                            contentAlignment = Alignment.Center,
                        ) {
                            Text(
                                text = if (gb == 0) "Unlimited" else "$gb GB",
                                color = if (selected) PearlInk else Dim,
                                fontSize = 12.5.sp,
                                fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Medium,
                                maxLines = 1,
                            )
                        }
                    }
                }
            }

            // Card 4 — Playback & MIDI
            SettingsGroupCard {
                Text("Playback & MIDI", color = Ink, fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
                Hint("Choose your own SoundFont 2 (.sf2), up to 256 MiB. Saved immediately on this device.")
                bankError?.let { Text(it, color = Danger, fontSize = 13.sp) }
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(7.dp),
                ) {
                    Box(
                        modifier = Modifier
                            .size(6.dp)
                            .clip(CircleShape)
                            .background(if (bankSelected) Accent else Dim),
                    )
                    Text(
                        text = if (bankSelected) "SoundFont (.sf2) selected" else "No SoundFont selected",
                        color = if (bankSelected) Accent else Dim,
                        fontSize = 13.sp,
                        fontWeight = FontWeight.Medium,
                    )
                }
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    HeroGlassButton(
                        text = if (bankBusy) "Importing…" else "Choose .sf2 file",
                        enabled = !bankBusy,
                        shape = PillShape,
                        onClick = { pickBank.launch(arrayOf("*/*")) },
                    )
                    if (bankSelected) {
                        HeroGlassButton(
                            text = "Remove",
                            enabled = !bankBusy,
                            shape = PillShape,
                            onClick = model::clearSoundFont,
                        )
                    }
                }
            }

            // Card 5 — Advanced Network & Engine (collapsible)
            SettingsGroupCard {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(ControlShape)
                        .clickable { advanced = !advanced }
                        .padding(vertical = 2.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        text = "Advanced Network & Engine",
                        color = Ink,
                        fontSize = 16.sp,
                        fontWeight = FontWeight.SemiBold,
                        modifier = Modifier.weight(1f),
                    )
                    Icon(
                        imageVector = if (advanced) ChevronDownIcon else ChevronRightIcon,
                        contentDescription = null,
                        tint = Dim,
                        modifier = Modifier.size(18.dp),
                    )
                }
                AnimatedVisibility(advanced) {
                    Column(
                        modifier = Modifier.padding(top = 8.dp),
                        verticalArrangement = Arrangement.spacedBy(16.dp),
                    ) {
                        Field("Blind relays", "Optional relay keys, for networks where peers cannot connect directly") {
                            KeyField(relays, singleLine = false) { relays = it }
                        }
                        Field("DHT bootstrap", "Optional host:port list for a private DHT. Empty uses the public DHT.") {
                            KeyField(bootstrap, singleLine = false) { bootstrap = it }
                        }
                        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Row(
                                Modifier
                                    .fillMaxWidth()
                                    .toggleable(value = lan, role = Role.Switch, onValueChange = { lan = it }),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Text("Find relays on this network", color = Ink, fontSize = 14.5.sp, fontWeight = FontWeight.Medium, modifier = Modifier.weight(1f))
                                Switch(checked = lan, onCheckedChange = null, colors = SwitchDefaults.colors(checkedTrackColor = Brand))
                            }
                            Hint("Over mDNS, on this device's Wi-Fi or Ethernet, for relays that run with PEARTUBE_LAN_HOST.")
                        }
                        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Row(
                                Modifier
                                    .fillMaxWidth()
                                    .toggleable(value = privateRouting, role = Role.Switch, onValueChange = { privateRouting = it }),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Text("Private DHT routing", color = Ink, fontSize = 14.5.sp, fontWeight = FontWeight.Medium, modifier = Modifier.weight(1f))
                                Switch(checked = privateRouting, onCheckedChange = null, colors = SwitchDefaults.colors(checkedTrackColor = Brand))
                            }
                            Hint("Route peer connections over 2-hop encrypted guard circuits. Every peer you connect to must also run with private routing.")
                        }
                    }
                }
            }

            Spacer(Modifier.height(16.dp))
        }
    }
}

@Composable
private fun SettingsGroupCard(
    content: @Composable ColumnScope.() -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(CardShape)
            .background(CardBg)
            .border(0.75.dp, GlassBorder, CardShape)
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
        content = content,
    )
}

@Composable
private fun Field(label: String, hint: String, input: @Composable () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(5.dp)) {
        Text(label, color = Ink, fontSize = 14.5.sp, fontWeight = FontWeight.SemiBold)
        Hint(hint)
        input()
    }
}

@Composable
private fun Hint(text: String) = Text(text, color = Dim, fontSize = 12.5.sp, lineHeight = 17.sp)

@Composable
private fun KeyField(value: String, singleLine: Boolean, onChange: (String) -> Unit) {
    OutlinedTextField(
        value = value,
        onValueChange = onChange,
        singleLine = singleLine,
        minLines = if (singleLine) 1 else 3,
        shape = CardShape,
        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false),
        colors = fieldColors(),
        modifier = Modifier.fillMaxWidth(),
    )
}
