package com.beacon.mesh.ui.components

import androidx.annotation.StringRes
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.Healing
import androidx.compose.material.icons.rounded.MedicalServices
import androidx.compose.material.icons.rounded.MoreHoriz
import androidx.compose.material.icons.rounded.Place
import androidx.compose.material.icons.rounded.Warning
import androidx.compose.material.icons.rounded.WaterDrop
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.LargeFlexibleTopAppBar
import androidx.compose.material3.LoadingIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.toShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Matrix
import androidx.compose.ui.graphics.Outline
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.asComposePath
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.graphics.shapes.Morph
import androidx.graphics.shapes.toPath
import com.beacon.mesh.R
import com.beacon.mesh.ui.theme.CategoryColors
import com.beacon.mesh.ui.theme.LocalCategoryColors
import com.beacon.mesh.ui.theme.LocalReduceMotion
import kotlinx.coroutines.delay

/** Max readable width of a content column on tablets / unfolded foldables. */
val ContentMaxWidth = 840.dp

/** Large expressive app bar (compact app bar in short landscape windows) around scrollable content. */
@Composable
fun ScreenScaffold(
    title: String,
    modifier: Modifier = Modifier,
    navigationIcon: @Composable () -> Unit = {},
    actions: @Composable androidx.compose.foundation.layout.RowScope.() -> Unit = {},
    floatingActionButton: @Composable () -> Unit = {},
    content: @Composable (PaddingValues) -> Unit,
) {
    val shortWindow = LocalConfiguration.current.screenHeightDp < 480
    val scroll = if (shortWindow) TopAppBarDefaults.pinnedScrollBehavior()
    else TopAppBarDefaults.exitUntilCollapsedScrollBehavior()
    Scaffold(
        modifier = modifier.nestedScroll(scroll.nestedScrollConnection),
        containerColor = Color.Transparent,
        floatingActionButton = floatingActionButton,
        topBar = {
            if (shortWindow) {
                TopAppBar(
                    title = { Text(title, maxLines = 1) },
                    navigationIcon = navigationIcon,
                    actions = actions,
                    scrollBehavior = scroll,
                )
            } else {
                LargeFlexibleTopAppBar(
                    title = { Text(title) },
                    navigationIcon = navigationIcon,
                    actions = actions,
                    scrollBehavior = scroll,
                )
            }
        },
        content = content,
    )
}

/** Vertically scrolling, width-limited, centered column. Every non-list screen is built on this. */
@Composable
fun ScrollColumn(
    padding: PaddingValues,
    modifier: Modifier = Modifier,
    content: @Composable ColumnScope.() -> Unit,
) {
    Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.TopCenter) {
        Column(
            modifier = modifier
                .widthIn(max = ContentMaxWidth)
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
            content = content,
        )
    }
}

@Composable
fun SectionTitle(text: String, modifier: Modifier = Modifier) {
    Text(
        text,
        style = MaterialTheme.typography.titleMediumEmphasized,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = modifier.semantics { heading() },
    )
}

@Composable
fun ElevatedSection(
    modifier: Modifier = Modifier,
    container: Color = MaterialTheme.colorScheme.surfaceContainer,
    content: @Composable ColumnScope.() -> Unit,
) {
    Card(
        modifier = modifier.fillMaxWidth(),
        shape = MaterialTheme.shapes.largeIncreased,
        colors = CardDefaults.cardColors(containerColor = container),
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp), content = content)
    }
}

/** Icon in a morphing cookie-shaped badge (expressive shape language). */
@Composable
fun BadgeIcon(
    icon: ImageVector,
    container: Color,
    content: Color,
    modifier: Modifier = Modifier,
    size: androidx.compose.ui.unit.Dp = 48.dp,
) {
    Surface(
        modifier = modifier.size(size),
        shape = androidx.compose.material3.MaterialShapes.Cookie9Sided.toShape(),
        color = container,
        contentColor = content,
    ) {
        Box(contentAlignment = Alignment.Center) {
            Icon(icon, contentDescription = null, modifier = Modifier.size(size / 2))
        }
    }
}

/** A shape that morphs between two polygons; [progress] 0..1. Used for state badges. */
class MorphShape(private val morph: Morph, private val progress: Float) : Shape {
    override fun createOutline(size: androidx.compose.ui.geometry.Size, layoutDirection: LayoutDirection, density: Density): Outline {
        val path = morph.toPath(progress).asComposePath()
        path.transform(Matrix().apply { scale(size.width, size.height) })
        return Outline.Generic(path)
    }
}

/** Empty / loading state. While [loading], an expressive LoadingIndicator replaces the icon. */
@Composable
fun EmptyState(
    icon: ImageVector,
    title: String,
    body: String,
    modifier: Modifier = Modifier,
    loading: Boolean = false,
    action: @Composable (() -> Unit)? = null,
) {
    Column(
        modifier = modifier.fillMaxWidth().padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        if (loading && !LocalReduceMotion.current) {
            LoadingIndicator(Modifier.size(64.dp))
        } else {
            BadgeIcon(icon, MaterialTheme.colorScheme.secondaryContainer, MaterialTheme.colorScheme.onSecondaryContainer, size = 64.dp)
        }
        Text(title, style = MaterialTheme.typography.titleLargeEmphasized, textAlign = TextAlign.Center)
        Text(body, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
        action?.invoke()
    }
}

/** Ticks every 30 s so "5 min ago" labels stay fresh. */
@Composable
fun rememberNow(): Long {
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(30_000)
            now = System.currentTimeMillis()
        }
    }
    return now
}

/** Visual identity of an SOS category. */
data class CategoryStyle(
    @param:StringRes val label: Int,
    val icon: ImageVector,
    val container: Color,
    val content: Color,
    /** Strong fill for the big SOS buttons. */
    val strong: Color,
    val onStrong: Color,
)

@Composable
fun categoryStyle(wire: String): CategoryStyle = categoryStyle(wire, LocalCategoryColors.current)

fun categoryStyle(wire: String, c: CategoryColors): CategoryStyle = when (wire) {
    "trapped" -> CategoryStyle(R.string.cat_trapped, Icons.Rounded.Warning, c.dangerContainer, c.onDangerContainer, c.danger, c.onDanger)
    "injured" -> CategoryStyle(R.string.cat_injured, Icons.Rounded.Healing, c.dangerContainer, c.onDangerContainer, c.danger, c.onDanger)
    "medical" -> CategoryStyle(R.string.cat_medical, Icons.Rounded.MedicalServices, c.dangerContainer, c.onDangerContainer, c.danger, c.onDanger)
    "water_meds" -> CategoryStyle(R.string.cat_water_meds, Icons.Rounded.WaterDrop, c.warnContainer, c.onWarnContainer, c.warn, c.onWarn)
    "safe" -> CategoryStyle(R.string.cat_safe, Icons.Rounded.CheckCircle, c.safeContainer, c.onSafeContainer, c.safe, c.onSafe)
    "checkin" -> CategoryStyle(R.string.cat_checkin, Icons.Rounded.Place, c.safeContainer, c.onSafeContainer, c.safe, c.onSafe)
    else -> CategoryStyle(R.string.cat_other, Icons.Rounded.MoreHoriz, c.warnContainer, c.onWarnContainer, c.warn, c.onWarn)
}

@Composable
fun categoryLabel(wire: String): String = stringResource(categoryStyle(wire).label)

/** Small colored pill (category, status). */
@Composable
fun Pill(text: String, container: Color, content: Color, icon: ImageVector? = null, modifier: Modifier = Modifier) {
    Surface(modifier = modifier, shape = CircleShape, color = container, contentColor = content) {
        Row(
            Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            if (icon != null) Icon(icon, null, Modifier.size(16.dp))
            Text(text, style = MaterialTheme.typography.labelLarge)
        }
    }
}

val NoInsets = WindowInsets(0, 0, 0, 0)
