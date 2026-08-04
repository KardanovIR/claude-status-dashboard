package com.kardanov.agstatus.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.ContentCopy
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.kardanov.agstatus.SessionStore
import com.kardanov.agstatus.Theme
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** Same canonical URLs the store listing points at, so they can't drift apart. */
private const val PRIVACY_URL = "https://agstatus.online/privacy"
private const val SOURCE_URL = "https://github.com/KardanovIR/claude-status-dashboard"

/** Board details, demo mode, and the dangerous stuff. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(store: SessionStore, onBack: () -> Unit, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val board by store.board.collectAsState()
    val connection by store.connection.collectAsState()
    val isDemo = connection == SessionStore.Connection.DEMO

    var copiedField by remember { mutableStateOf<String?>(null) }
    var confirmDisconnect by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf(false) }
    var isDeleting by remember { mutableStateOf(false) }
    var deleteError by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(copiedField) {
        if (copiedField != null) {
            delay(1_500)
            copiedField = null
        }
    }

    fun copy(field: String, value: String) {
        copyToClipboard(context, value)
        copiedField = field
    }

    fun deleteBoard() {
        if (isDeleting) return
        isDeleting = true
        scope.launch {
            try {
                store.deleteBoardEverywhere()
                onBack()
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                deleteError = friendlyMessage(error)
            }
            isDeleting = false
        }
    }

    Scaffold(
        modifier = modifier,
        containerColor = Theme.background,
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        text = "Settings",
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.SemiBold,
                    )
                },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Rounded.ArrowBack, contentDescription = "Back")
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = Theme.background,
                    titleContentColor = Theme.textPrimary,
                    navigationIconContentColor = Theme.textPrimary,
                ),
            )
        },
    ) { insets ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(insets)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp)
                .padding(top = 8.dp, bottom = 32.dp),
            verticalArrangement = Arrangement.spacedBy(22.dp),
        ) {
            board?.let { current ->
                Section(title = "Board") {
                    ValueRow(title = "Server", value = hostOf(current.baseUrl))
                    RowDivider()
                    CopyRow(
                        title = "Board URL",
                        value = current.boardUrl,
                        copied = copiedField == "board",
                        onCopy = { copy("board", current.boardUrl) },
                        onOpen = { openUrl(context, current.boardUrl) },
                    )
                    RowDivider()
                    CopyRow(
                        title = "Webhook",
                        value = current.webhookUrl,
                        copied = copiedField == "webhook",
                        onCopy = { copy("webhook", current.webhookUrl) },
                    )
                }
            }

            Section(
                title = "Demo",
                footer = "Fills the board with sample agents so you can see how it feels.",
            ) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(min = 52.dp)
                        .padding(horizontal = 14.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        text = "Demo mode",
                        style = MaterialTheme.typography.bodyLarge,
                        color = Theme.textPrimary,
                        modifier = Modifier.weight(1f),
                    )
                    Switch(
                        checked = isDemo,
                        onCheckedChange = { enabled ->
                            if (enabled) {
                                store.startDemo()
                                onBack()
                            } else {
                                store.stopDemo()
                            }
                        },
                        colors = SwitchDefaults.colors(
                            checkedThumbColor = Theme.textPrimary,
                            checkedTrackColor = Theme.planning,
                            checkedBorderColor = Theme.planning,
                            uncheckedThumbColor = Theme.textSecondary,
                            uncheckedTrackColor = Theme.card,
                            uncheckedBorderColor = Theme.cardBorder,
                        ),
                    )
                }
            }

            board?.let { current ->
                Section(title = "Danger zone") {
                    DangerRow(
                        title = "Disconnect this device",
                        enabled = !isDeleting,
                        onClick = { confirmDisconnect = true },
                    )
                    if (current.token != null) {
                        RowDivider()
                        DangerRow(
                            title = "Delete board and all its data",
                            enabled = !isDeleting,
                            busy = isDeleting,
                            onClick = { confirmDelete = true },
                        )
                    }
                }
            }

            Section(title = "About") {
                ValueRow(title = "Version", value = appVersion(context))
                RowDivider()
                LinkRow(title = "Privacy policy", onClick = { openUrl(context, PRIVACY_URL) })
                RowDivider()
                LinkRow(title = "Source code", onClick = { openUrl(context, SOURCE_URL) })
            }
        }
    }

    if (confirmDisconnect) {
        ConfirmDialog(
            title = "Disconnect this device?",
            message = "The board stays on the server — you can reconnect anytime by " +
                "scanning its QR code again.",
            confirmLabel = "Disconnect",
            onConfirm = {
                confirmDisconnect = false
                store.disconnectBoard()
                onBack()
            },
            onDismiss = { confirmDisconnect = false },
        )
    }

    if (confirmDelete) {
        ConfirmDialog(
            title = "Delete this board for everyone?",
            message = "This removes the board and all its history from the server. " +
                "There's no undo.",
            confirmLabel = "Delete board",
            onConfirm = {
                confirmDelete = false
                deleteBoard()
            },
            onDismiss = { confirmDelete = false },
        )
    }

    deleteError?.let { message ->
        AlertDialog(
            onDismissRequest = { deleteError = null },
            containerColor = Theme.card,
            titleContentColor = Theme.textPrimary,
            textContentColor = Theme.textSecondary,
            title = { Text("Couldn't delete the board") },
            text = { Text(message) },
            confirmButton = {
                TextButton(onClick = { deleteError = null }) {
                    Text("OK", color = Theme.planning)
                }
            },
        )
    }
}

// MARK: - Building blocks

@Composable
private fun Section(
    title: String,
    footer: String? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    Column(
        modifier = Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            text = title.uppercase(),
            style = MaterialTheme.typography.labelSmall,
            color = Theme.textSecondary,
            modifier = Modifier.padding(start = 4.dp),
        )
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(14.dp))
                .background(Theme.card)
                .border(1.dp, Theme.cardBorder, RoundedCornerShape(14.dp)),
            content = content,
        )
        footer?.let {
            Text(
                text = it,
                style = MaterialTheme.typography.bodySmall,
                color = Theme.textSecondary,
                modifier = Modifier.padding(horizontal = 4.dp),
            )
        }
    }
}

@Composable
private fun RowDivider() {
    HorizontalDivider(thickness = 1.dp, color = Theme.cardBorder)
}

@Composable
private fun ValueRow(title: String, value: String) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 52.dp)
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = title,
            style = MaterialTheme.typography.bodyLarge,
            color = Theme.textPrimary,
            modifier = Modifier.weight(1f),
        )
        Text(
            text = value,
            style = MaterialTheme.typography.bodyMedium,
            color = Theme.textSecondary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun CopyRow(
    title: String,
    value: String,
    copied: Boolean,
    onCopy: () -> Unit,
    onOpen: (() -> Unit)? = null,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onCopy)
            .heightIn(min = 52.dp)
            .padding(start = 14.dp, end = 6.dp, top = 10.dp, bottom = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = title,
                style = MaterialTheme.typography.bodyLarge,
                color = Theme.textPrimary,
            )
            Text(
                text = value,
                fontFamily = FontFamily.Monospace,
                fontSize = 12.sp,
                color = Theme.textSecondary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        if (onOpen != null) {
            TextButton(onClick = onOpen) {
                Text(
                    text = "Open",
                    style = MaterialTheme.typography.labelLarge,
                    color = Theme.planning,
                )
            }
        }
        IconButton(onClick = onCopy) {
            Icon(
                imageVector = if (copied) Icons.Rounded.Check else Icons.Rounded.ContentCopy,
                contentDescription = "Copy $title",
                tint = if (copied) Theme.done else Theme.textSecondary,
                modifier = Modifier.size(18.dp),
            )
        }
    }
}

@Composable
private fun LinkRow(title: String, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .heightIn(min = 52.dp)
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = title,
            style = MaterialTheme.typography.bodyLarge,
            color = Theme.textPrimary,
            modifier = Modifier.weight(1f),
        )
        Text(
            text = "Open",
            style = MaterialTheme.typography.labelLarge,
            color = Theme.planning,
        )
    }
}

@Composable
private fun DangerRow(
    title: String,
    enabled: Boolean,
    onClick: () -> Unit,
    busy: Boolean = false,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(enabled = enabled, onClick = onClick)
            .heightIn(min = 52.dp)
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = title,
            style = MaterialTheme.typography.bodyLarge,
            color = if (enabled) Theme.blocked else Theme.blocked.copy(alpha = 0.5f),
            modifier = Modifier.weight(1f),
        )
        if (busy) {
            Spacer(Modifier.size(8.dp))
            CircularProgressIndicator(
                modifier = Modifier.size(18.dp),
                color = Theme.textSecondary,
                strokeWidth = 2.dp,
            )
        }
    }
}

@Composable
private fun ConfirmDialog(
    title: String,
    message: String,
    confirmLabel: String,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = Theme.card,
        titleContentColor = Theme.textPrimary,
        textContentColor = Theme.textSecondary,
        title = { Text(title) },
        text = { Text(message) },
        confirmButton = {
            TextButton(onClick = onConfirm) {
                Text(confirmLabel, color = Theme.blocked)
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text("Cancel", color = Theme.textSecondary)
            }
        },
    )
}

// MARK: - Helpers

private fun hostOf(baseUrl: String): String = Uri.parse(baseUrl).host ?: baseUrl

private fun appVersion(context: Context): String =
    runCatching {
        context.packageManager.getPackageInfo(context.packageName, 0).versionName
    }.getOrNull() ?: "1.0"

private fun openUrl(context: Context, url: String) {
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    runCatching { context.startActivity(intent) }
}

private fun copyToClipboard(context: Context, text: String) {
    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return
    clipboard.setPrimaryClip(ClipData.newPlainText("AgStatus", text))
}
