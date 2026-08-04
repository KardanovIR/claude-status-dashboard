package com.kardanov.agstatus.ui

import android.content.ClipboardManager
import android.content.Context
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.ContentPaste
import androidx.compose.material.icons.rounded.ExpandMore
import androidx.compose.material.icons.rounded.Link
import androidx.compose.material.icons.rounded.QrCodeScanner
import androidx.compose.material.icons.rounded.ShowChart
import androidx.compose.material3.BottomSheetDefaults
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.kardanov.agstatus.AgStatusApi
import com.kardanov.agstatus.ApiException
import com.kardanov.agstatus.Board
import com.kardanov.agstatus.SessionStore
import com.kardanov.agstatus.Theme
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.net.URI

/** First-run screen: create a board, scan a setup QR, or paste a board URL. */
@Composable
fun WelcomeScreen(store: SessionStore, modifier: Modifier = Modifier) {
    var showScanner by rememberSaveable { mutableStateOf(false) }
    var showUrlEntry by rememberSaveable { mutableStateOf(false) }
    var showServerField by rememberSaveable { mutableStateOf(false) }
    var serverText by rememberSaveable { mutableStateOf("") }
    var errorText by remember { mutableStateOf<String?>(null) }
    var isCreating by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    if (showScanner) {
        ScannerScreen(
            onResult = { payload ->
                showScanner = false
                scope.launch {
                    errorText = adoptBoard(payload, store, "That's not an AgStatus board QR.")
                }
            },
            onCancel = { showScanner = false },
        )
        return
    }

    fun createBoard() {
        if (isCreating) return
        errorText = null
        val base = normalizedServer(serverText)
        if (base == null) {
            errorText = "That server address doesn't look right."
            return
        }
        isCreating = true
        scope.launch {
            errorText = try {
                // Legacy single-tenant servers have no workspaces — the whole
                // server IS the board. Probe first so a self-hoster isn't met
                // with a misleading "board no longer exists" from the 404.
                if (AgStatusApi.serverMode(base) == "legacy") {
                    val board = Board(base, null)
                    AgStatusApi.sessions(board)
                    store.adopt(board)
                } else {
                    store.adopt(AgStatusApi.createBoard(base))
                }
                null
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                friendlyMessage(error)
            }
            isCreating = false
        }
    }

    Column(
        modifier = modifier
            .fillMaxSize()
            .background(Theme.background)
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 24.dp)
            .padding(top = 48.dp, bottom = 32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(32.dp),
    ) {
        WelcomeHeader()

        Column(
            modifier = Modifier.fillMaxWidth(),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Button(
                onClick = { createBoard() },
                enabled = !isCreating,
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(12.dp),
                colors = ButtonDefaults.buttonColors(
                    containerColor = Theme.planning,
                    contentColor = Theme.textPrimary,
                    disabledContainerColor = Theme.planning.copy(alpha = 0.5f),
                    disabledContentColor = Theme.textPrimary.copy(alpha = 0.7f),
                ),
                contentPadding = PaddingValues(horizontal = 16.dp, vertical = 14.dp),
            ) {
                if (isCreating) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(18.dp),
                        color = Theme.textPrimary,
                        strokeWidth = 2.dp,
                    )
                    Spacer(Modifier.size(10.dp))
                }
                Text(
                    text = if (isCreating) "Creating…" else "Create a status board",
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                )
            }

            SecondaryAction(
                text = "Scan setup QR code",
                icon = Icons.Rounded.QrCodeScanner,
                onClick = {
                    errorText = null
                    showScanner = true
                },
            )

            SecondaryAction(
                text = "Enter board URL",
                icon = Icons.Rounded.Link,
                onClick = {
                    errorText = null
                    showUrlEntry = true
                },
            )

            errorText?.let { message ->
                Text(
                    text = message,
                    style = MaterialTheme.typography.bodySmall,
                    color = Theme.blocked,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.padding(top = 4.dp),
                )
            }
        }

        SelfHostingSection(
            expanded = showServerField,
            serverText = serverText,
            onToggle = { showServerField = !showServerField },
            onServerTextChange = {
                serverText = it
                errorText = null
            },
        )

        TextButton(onClick = { store.startDemo() }) {
            Text(
                text = "Try the demo",
                style = MaterialTheme.typography.bodySmall,
                fontWeight = FontWeight.Medium,
                color = Theme.planning,
            )
        }
    }

    if (showUrlEntry) {
        BoardUrlSheet(store = store, onDismiss = { showUrlEntry = false })
    }
}

// MARK: - Sections

@Composable
private fun WelcomeHeader() {
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Box(
            modifier = Modifier
                .size(84.dp)
                .clip(RoundedCornerShape(22.dp))
                .background(Theme.card)
                .border(1.dp, Theme.cardBorder, RoundedCornerShape(22.dp)),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                imageVector = Icons.Rounded.ShowChart,
                contentDescription = null,
                tint = Theme.coding,
                modifier = Modifier.size(44.dp),
            )
        }
        Text(
            text = "AgStatus",
            fontSize = 40.sp,
            fontWeight = FontWeight.Bold,
            color = Theme.textPrimary,
        )
        Text(
            text = "Live status board for your coding agents",
            style = MaterialTheme.typography.bodyMedium,
            color = Theme.textSecondary,
            textAlign = TextAlign.Center,
        )
    }
}

@Composable
private fun SecondaryAction(text: String, icon: ImageVector, onClick: () -> Unit) {
    OutlinedButton(
        onClick = onClick,
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(12.dp),
        colors = ButtonDefaults.outlinedButtonColors(
            containerColor = Theme.card,
            contentColor = Theme.textPrimary,
        ),
        border = BorderStroke(1.dp, Theme.cardBorder),
        contentPadding = PaddingValues(horizontal = 16.dp, vertical = 14.dp),
    ) {
        Icon(imageVector = icon, contentDescription = null, modifier = Modifier.size(20.dp))
        Spacer(Modifier.size(10.dp))
        Text(
            text = text,
            style = MaterialTheme.typography.titleSmall,
            fontWeight = FontWeight.SemiBold,
        )
    }
}

@Composable
private fun SelfHostingSection(
    expanded: Boolean,
    serverText: String,
    onToggle: () -> Unit,
    onServerTextChange: (String) -> Unit,
) {
    val rotation by animateFloatAsState(
        targetValue = if (expanded) 180f else 0f,
        label = "selfHostingChevron",
    )
    Column(
        modifier = Modifier.fillMaxWidth(),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(
            modifier = Modifier
                .clip(RoundedCornerShape(8.dp))
                .clickable(onClick = onToggle)
                .padding(horizontal = 8.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(5.dp),
        ) {
            Text(
                text = "Self-hosting? Point any action at your own server",
                style = MaterialTheme.typography.bodySmall,
                color = Theme.textSecondary,
                textAlign = TextAlign.Center,
            )
            Icon(
                imageVector = Icons.Rounded.ExpandMore,
                contentDescription = null,
                tint = Theme.textSecondary,
                modifier = Modifier
                    .size(16.dp)
                    .rotate(rotation),
            )
        }

        AnimatedVisibility(visible = expanded) {
            UrlInputField(
                value = serverText,
                onValueChange = onServerTextChange,
                placeholder = "https://your-server.example",
            )
        }
    }
}

/** Small sheet for pasting or typing a board URL by hand. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun BoardUrlSheet(store: SessionStore, onDismiss: () -> Unit) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val focusRequester = remember { FocusRequester() }
    val scope = rememberCoroutineScope()
    var text by rememberSaveable { mutableStateOf("") }
    var errorText by remember { mutableStateOf<String?>(null) }
    var isConnecting by remember { mutableStateOf(false) }

    fun connect() {
        if (isConnecting || text.isBlank()) return
        errorText = null
        isConnecting = true
        scope.launch {
            val failure = adoptBoard(text, store, "That doesn't look like a board URL.")
            errorText = failure
            isConnecting = false
            if (failure == null) onDismiss()
        }
    }

    // The field can only take focus once the sheet's content is attached.
    LaunchedEffect(focusRequester) {
        delay(250)
        runCatching { focusRequester.requestFocus() }
    }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = Theme.background,
        dragHandle = { BottomSheetDefaults.DragHandle(color = Theme.textSecondary) },
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .imePadding()
                .padding(horizontal = 20.dp)
                .padding(bottom = 28.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text(
                text = "Enter board URL",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
                color = Theme.textPrimary,
            )
            Text(
                text = "Paste the board URL from your dashboard or from the setup output on your computer.",
                style = MaterialTheme.typography.bodyMedium,
                color = Theme.textSecondary,
            )
            UrlInputField(
                value = text,
                onValueChange = {
                    text = it
                    errorText = null
                },
                placeholder = "https://…/w/ags_…",
                modifier = Modifier.focusRequester(focusRequester),
                onSubmit = { connect() },
            )
            errorText?.let { message ->
                Text(
                    text = message,
                    style = MaterialTheme.typography.bodySmall,
                    color = Theme.blocked,
                )
            }
            Button(
                onClick = { connect() },
                enabled = !isConnecting && text.isNotBlank(),
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(12.dp),
                colors = ButtonDefaults.buttonColors(
                    containerColor = Theme.planning,
                    contentColor = Theme.textPrimary,
                    disabledContainerColor = Theme.planning.copy(alpha = 0.5f),
                    disabledContentColor = Theme.textPrimary.copy(alpha = 0.7f),
                ),
                contentPadding = PaddingValues(horizontal = 16.dp, vertical = 14.dp),
            ) {
                if (isConnecting) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(18.dp),
                        color = Theme.textPrimary,
                        strokeWidth = 2.dp,
                    )
                    Spacer(Modifier.size(10.dp))
                }
                Text(
                    text = if (isConnecting) "Checking…" else "Connect",
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                )
            }
        }
    }
}

// MARK: - Shared pieces

/**
 * Monospaced URL field with a paste shortcut, shared by the board-URL sheet,
 * the self-hosting field and the scanner's manual fallback.
 */
@Composable
internal fun UrlInputField(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    modifier: Modifier = Modifier,
    onSubmit: () -> Unit = {},
) {
    val context = LocalContext.current
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        modifier = modifier.fillMaxWidth(),
        textStyle = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 14.sp),
        placeholder = {
            Text(
                text = placeholder,
                fontFamily = FontFamily.Monospace,
                fontSize = 13.sp,
                maxLines = 1,
            )
        },
        singleLine = true,
        shape = RoundedCornerShape(10.dp),
        keyboardOptions = KeyboardOptions(
            keyboardType = KeyboardType.Uri,
            imeAction = ImeAction.Go,
        ),
        keyboardActions = KeyboardActions(onGo = { onSubmit() }),
        trailingIcon = {
            IconButton(onClick = { clipboardText(context)?.let(onValueChange) }) {
                Icon(
                    imageVector = Icons.Rounded.ContentPaste,
                    contentDescription = "Paste from clipboard",
                    tint = Theme.textSecondary,
                )
            }
        },
        colors = OutlinedTextFieldDefaults.colors(
            focusedTextColor = Theme.textPrimary,
            unfocusedTextColor = Theme.textPrimary,
            focusedContainerColor = Theme.card,
            unfocusedContainerColor = Theme.card,
            cursorColor = Theme.planning,
            focusedBorderColor = Theme.planning,
            unfocusedBorderColor = Theme.cardBorder,
            focusedPlaceholderColor = Theme.textSecondary,
            unfocusedPlaceholderColor = Theme.textSecondary,
        ),
    )
}

// MARK: - Helpers

/**
 * Parses, probes and adopts a board. Returns null on success, or the message
 * to show inline when the input is unusable or the server can't confirm it.
 */
private suspend fun adoptBoard(raw: String, store: SessionStore, parseError: String): String? {
    val board = parseBoardInput(raw) ?: return parseError
    return try {
        AgStatusApi.sessions(board)
        store.adopt(board)
        null
    } catch (error: CancellationException) {
        throw error
    } catch (error: Exception) {
        friendlyMessage(error)
    }
}

/** Users type hosts without a scheme far more often than they type one. */
private fun parseBoardInput(raw: String): Board? {
    val trimmed = raw.trim()
    if (trimmed.isEmpty()) return null
    return Board.parse(if (hasScheme(trimmed)) trimmed else "https://$trimmed")
}

/** The custom server field (when filled) wins; otherwise the default server. */
private fun normalizedServer(raw: String): String? {
    val trimmed = raw.trim()
    if (trimmed.isEmpty()) return Board.DEFAULT_SERVER
    val candidate = if (hasScheme(trimmed)) trimmed else "https://$trimmed"
    val uri = runCatching { URI(candidate) }.getOrNull() ?: return null
    val scheme = uri.scheme?.lowercase() ?: return null
    if (scheme != "http" && scheme != "https") return null
    val host = uri.host?.takeIf { it.isNotEmpty() } ?: return null
    return if (uri.port > 0) "$scheme://$host:${uri.port}" else "$scheme://$host"
}

private fun hasScheme(value: String): Boolean =
    value.startsWith("http://", ignoreCase = true) || value.startsWith("https://", ignoreCase = true)

internal fun friendlyMessage(error: Throwable): String =
    (error as? ApiException)?.message ?: "Something went wrong. Please try again."

private fun clipboardText(context: Context): String? {
    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return null
    val item = clipboard.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0) ?: return null
    return item.coerceToText(context).toString().takeIf { it.isNotBlank() }
}
