package com.beacon.mesh.ui.screens

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearWavyProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.collectAsState
import androidx.compose.ui.Alignment
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.role
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusDirection
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.beacon.mesh.R
import com.beacon.mesh.profile.BloodType
import com.beacon.mesh.profile.ErrorKind
import com.beacon.mesh.profile.FieldError
import com.beacon.mesh.profile.MobilityNeed
import com.beacon.mesh.profile.ProfileRules
import com.beacon.mesh.ui.components.ElevatedSection
import com.beacon.mesh.ui.components.SectionTitle
import com.beacon.mesh.ui.haptics.HapticEvent
import com.beacon.mesh.ui.haptics.LocalHaptics
import com.beacon.mesh.ui.logic.PetForm
import com.beacon.mesh.ui.logic.ProfileEditor
import com.beacon.mesh.ui.logic.ProfileForm
import com.beacon.mesh.ui.logic.ProfileSection

private fun sectionTitle(s: ProfileSection) = when (s) {
    ProfileSection.IDENTITY -> R.string.profile_step_identity
    ProfileSection.APPEARANCE -> R.string.profile_step_appearance
    ProfileSection.MEDICAL -> R.string.profile_step_medical
    ProfileSection.HOUSEHOLD -> R.string.profile_step_household
    ProfileSection.CONTACT -> R.string.profile_step_contact
    ProfileSection.NOTES -> R.string.profile_step_notes
}

@Composable
private fun FieldError.text(): String = when (kind) {
    ErrorKind.REQUIRED -> stringResource(R.string.profile_err_required)
    ErrorKind.TOO_LONG -> stringResource(R.string.profile_err_too_long, max)
    ErrorKind.OUT_OF_RANGE -> stringResource(R.string.profile_err_range, min, max)
    ErrorKind.BAD_PHONE -> stringResource(R.string.profile_err_phone)
    ErrorKind.TOO_MANY -> stringResource(R.string.profile_err_too_many, max)
    ErrorKind.BAD_NUMBER -> stringResource(R.string.profile_err_number)
    ErrorKind.EXCEEDS_PEOPLE -> stringResource(R.string.profile_err_exceeds, max)
    ErrorKind.BAD_LANGUAGE -> stringResource(R.string.profile_err_language, min, max)
    ErrorKind.INVALID_CHARS -> stringResource(R.string.profile_err_chars)
}

/**
 * The multi-section profile form: a progress indicator across sections, one section at a time, "Save and finish" any time the
 * data is valid. Used by onboarding (after the consent card) and by Settings > My profile.
 */
@Composable
fun ProfileFormPane(
    editor: ProfileEditor,
    saveLabel: Int,
    onSave: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val haptics = LocalHaptics.current
    val form by editor.form.collectAsState()
    val step by editor.step.collectAsState()
    val attempted by editor.attempted.collectAsState()
    val errors = if (attempted) form.errors() else emptyMap()
    val section = ProfileSection.entries[step]
    val total = ProfileSection.entries.size
    val title = stringResource(sectionTitle(section))
    val progressText = stringResource(R.string.profile_section_progress, step + 1, total, title)

    Column(modifier, verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Column(Modifier.semantics(mergeDescendants = true) { contentDescription = progressText }, verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(progressText, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
            LinearWavyProgressIndicator(progress = { (step + 1f) / total }, modifier = Modifier.fillMaxWidth().clearAndSetSemantics { })
        }

        AnimatedContent(
            targetState = step,
            transitionSpec = {
                val dir = if (targetState >= initialState) 1 else -1
                (fadeIn() + slideInHorizontally { dir * it / 6 }) togetherWith (fadeOut() + slideOutHorizontally { -dir * it / 6 })
            },
            label = "profile-section",
        ) { s ->
            ElevatedSection {
                Text(
                    stringResource(sectionTitle(ProfileSection.entries[s])),
                    style = MaterialTheme.typography.titleLargeEmphasized,
                    modifier = Modifier.semantics { heading() },
                )
                SectionFields(ProfileSection.entries[s], form, errors, editor)
            }
        }

        if (errors.isNotEmpty()) {
            Text(stringResource(R.string.profile_fix_errors), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.error)
        }

        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
            if (step > 0) {
                OutlinedButton(
                    onClick = haptics.onClick(HapticEvent.Navigate) { editor.back() },
                    shapes = ButtonDefaults.shapes(),
                    modifier = Modifier.heightIn(min = 48.dp),
                ) { Text(stringResource(R.string.profile_back), maxLines = 1) }
            }
            if (!editor.isLast) {
                Button(
                    onClick = {
                        if (editor.next()) haptics.perform(HapticEvent.Navigate) else haptics.perform(HapticEvent.Error)
                    },
                    shapes = ButtonDefaults.shapes(),
                    modifier = Modifier.weight(1f).heightIn(min = 56.dp),
                ) { Text(stringResource(R.string.profile_next)) }
            } else {
                Button(
                    onClick = { onSave() },
                    shapes = ButtonDefaults.shapes(),
                    modifier = Modifier.weight(1f).heightIn(min = 56.dp),
                ) { Text(stringResource(saveLabel)) }
            }
        }
        if (!editor.isLast) {
            FilledTonalButton(
                onClick = { onSave() },
                shapes = ButtonDefaults.shapes(),
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
            ) { Text(stringResource(saveLabel)) }
        }
    }
}

@Composable
private fun SectionFields(section: ProfileSection, f: ProfileForm, e: Map<String, FieldError>, ed: ProfileEditor) {
    when (section) {
        ProfileSection.IDENTITY -> {
            PField(f.fullName, { v -> ed.edit { it.copy(fullName = v) } }, R.string.profile_f_full_name, e["full_name"],
                KeyboardType.Text, ImeAction.Next, capitalization = KeyboardCapitalization.Words, required = true)
            PField(f.preferredName, { v -> ed.edit { it.copy(preferredName = v) } }, R.string.profile_f_preferred_name, e["preferred_name"],
                KeyboardType.Text, ImeAction.Next, capitalization = KeyboardCapitalization.Words)
            PField(f.birthYear, { v -> ed.edit { it.copy(birthYear = v.filter(Char::isDigit).take(4)) } }, R.string.profile_f_birth_year, e["birth_year"],
                KeyboardType.Number, ImeAction.Next)
            PField(f.languages, { v -> ed.edit { it.copy(languages = v) } }, R.string.profile_f_languages, e["languages"],
                KeyboardType.Text, ImeAction.Next, hint = R.string.profile_f_languages_hint)
            PField(f.phone, { v -> ed.edit { it.copy(phone = v) } }, R.string.profile_f_phone, e["phone"], KeyboardType.Phone, ImeAction.Done)
        }
        ProfileSection.APPEARANCE -> {
            HeightField(f.height, e["appearance.height_cm"]) { cm -> ed.edit { it.copy(height = cm) } }
            PField(f.hair, { v -> ed.edit { it.copy(hair = v) } }, R.string.profile_f_hair, e["appearance.hair"], KeyboardType.Text, ImeAction.Next)
            PField(f.clothing, { v -> ed.edit { it.copy(clothing = v) } }, R.string.profile_f_clothing, e["appearance.clothing"], KeyboardType.Text, ImeAction.Next)
            PField(f.marks, { v -> ed.edit { it.copy(marks = v) } }, R.string.profile_f_marks, e["appearance.distinguishing_marks"], KeyboardType.Text, ImeAction.Done, singleLine = false)
        }
        ProfileSection.MEDICAL -> {
            PField(f.conditions, { v -> ed.edit { it.copy(conditions = v) } }, R.string.profile_f_conditions, e["medical.conditions"], KeyboardType.Text, ImeAction.Next, hint = R.string.profile_f_list_hint, singleLine = false)
            PField(f.medications, { v -> ed.edit { it.copy(medications = v) } }, R.string.profile_f_medications, e["medical.medications"], KeyboardType.Text, ImeAction.Next, hint = R.string.profile_f_list_hint, singleLine = false)
            PField(f.allergies, { v -> ed.edit { it.copy(allergies = v) } }, R.string.profile_f_allergies, e["medical.allergies"], KeyboardType.Text, ImeAction.Next, hint = R.string.profile_f_list_hint, singleLine = false)
            BloodTypePicker(f.bloodType) { b -> ed.edit { it.copy(bloodType = b) } }
            MobilityChips(f.mobilityNeeds) { n -> ed.edit { it.copy(mobilityNeeds = n) } }
            PField(f.mobilityNotes, { v -> ed.edit { it.copy(mobilityNotes = v) } }, R.string.profile_f_mobility_notes, e["mobility.notes"], KeyboardType.Text, ImeAction.Done, singleLine = false)
        }
        ProfileSection.HOUSEHOLD -> {
            PField(f.peopleCount, { v -> ed.edit { it.copy(peopleCount = v.filter(Char::isDigit).take(2)) } }, R.string.profile_f_people, e["household.people_count"], KeyboardType.Number, ImeAction.Next)
            PField(f.children, { v -> ed.edit { it.copy(children = v.filter(Char::isDigit).take(2)) } }, R.string.profile_f_children, e["household.children"], KeyboardType.Number, ImeAction.Next)
            PField(f.elderly, { v -> ed.edit { it.copy(elderly = v.filter(Char::isDigit).take(2)) } }, R.string.profile_f_elderly, e["household.elderly"], KeyboardType.Number, ImeAction.Next)
            PetsEditor(f.pets, e, { p -> ed.edit { it.copy(pets = p) } })
        }
        ProfileSection.CONTACT -> {
            PField(f.contactName, { v -> ed.edit { it.copy(contactName = v) } }, R.string.profile_f_contact_name, e["emergency_contact.name"], KeyboardType.Text, ImeAction.Next, capitalization = KeyboardCapitalization.Words)
            PField(f.contactPhone, { v -> ed.edit { it.copy(contactPhone = v) } }, R.string.profile_f_contact_phone, e["emergency_contact.phone"], KeyboardType.Phone, ImeAction.Next)
            PField(f.contactRelationship, { v -> ed.edit { it.copy(contactRelationship = v) } }, R.string.profile_f_contact_rel, e["emergency_contact.relationship"], KeyboardType.Text, ImeAction.Next)
            PField(f.homeAddress, { v -> ed.edit { it.copy(homeAddress = v) } }, R.string.profile_f_address, e["home_address"], KeyboardType.Text, ImeAction.Done, singleLine = false, capitalization = KeyboardCapitalization.Words)
        }
        ProfileSection.NOTES -> {
            PField(f.notes, { v -> ed.edit { it.copy(notes = v) } }, R.string.profile_f_notes, e["notes"], KeyboardType.Text, ImeAction.Done, singleLine = false, minLines = 4)
        }
    }
}

@Composable
private fun PField(
    value: String,
    onChange: (String) -> Unit,
    label: Int,
    error: FieldError?,
    keyboard: KeyboardType,
    ime: ImeAction,
    modifier: Modifier = Modifier,
    singleLine: Boolean = true,
    minLines: Int = 1,
    hint: Int? = null,
    required: Boolean = false,
    capitalization: KeyboardCapitalization = KeyboardCapitalization.Sentences,
    errorOverride: String? = null,
) {
    val haptics = LocalHaptics.current
    val focus = LocalFocusManager.current
    val labelText = stringResource(label) + if (required) " *" else ""
    val errorText = errorOverride ?: error?.text()
    OutlinedTextField(
        value = value,
        onValueChange = onChange,
        label = { Text(labelText) },
        isError = errorText != null,
        supportingText = (errorText ?: hint?.let { stringResource(it) })?.let { t -> { Text(t) } },
        singleLine = singleLine,
        minLines = minLines,
        maxLines = if (singleLine) 1 else 6,
        keyboardOptions = KeyboardOptions(
            capitalization = if (keyboard == KeyboardType.Text) capitalization else KeyboardCapitalization.None,
            keyboardType = keyboard,
            imeAction = if (singleLine) ime else if (ime == ImeAction.Done) ImeAction.Default else ime,
        ),
        keyboardActions = KeyboardActions(
            onNext = { haptics.perform(HapticEvent.LightTap); focus.moveFocus(FocusDirection.Down) },
            onDone = { haptics.perform(HapticEvent.Tap); focus.clearFocus() },
        ),
        modifier = modifier.fillMaxWidth().heightIn(min = 56.dp).onFocusChanged { if (it.isFocused) haptics.perform(HapticEvent.LightTap) },
    )
}

@Composable
private fun BloodTypePicker(selected: BloodType?, onSelect: (BloodType?) -> Unit) {
    val haptics = LocalHaptics.current
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        SectionTitle(stringResource(R.string.profile_f_blood_type))
        @OptIn(ExperimentalLayoutApi::class)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            BloodType.entries.forEach { b ->
                FilterChip(
                    selected = selected == b,
                    onClick = haptics.onSelect { onSelect(if (selected == b) null else b) },
                    label = { Text(if (b == BloodType.UNKNOWN) stringResource(R.string.profile_blood_unknown) else b.wire) },
                    modifier = Modifier.heightIn(min = 48.dp),
                )
            }
        }
    }
}

private fun needLabel(n: MobilityNeed) = when (n) {
    MobilityNeed.WHEELCHAIR -> R.string.profile_need_wheelchair
    MobilityNeed.CANNOT_WALK -> R.string.profile_need_cannot_walk
    MobilityNeed.WALKS_WITH_AID -> R.string.profile_need_walks_with_aid
    MobilityNeed.VISION_IMPAIRED -> R.string.profile_need_vision_impaired
    MobilityNeed.HEARING_IMPAIRED -> R.string.profile_need_hearing_impaired
    MobilityNeed.COGNITIVE -> R.string.profile_need_cognitive
    MobilityNeed.OXYGEN_DEPENDENT -> R.string.profile_need_oxygen_dependent
    MobilityNeed.OTHER -> R.string.profile_need_other
}

@Composable
fun mobilityNeedLabel(n: MobilityNeed) = stringResource(needLabel(n))

@Composable
private fun MobilityChips(selected: Set<MobilityNeed>, onChange: (Set<MobilityNeed>) -> Unit) {
    val haptics = LocalHaptics.current
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        SectionTitle(stringResource(R.string.profile_f_mobility_needs))
        @OptIn(ExperimentalLayoutApi::class)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            MobilityNeed.entries.forEach { n ->
                val on = n in selected
                FilterChip(
                    selected = on,
                    onClick = { haptics.toggle(!on); onChange(if (on) selected - n else selected + n) },
                    label = { Text(stringResource(needLabel(n))) },
                    modifier = Modifier.heightIn(min = 48.dp),
                )
            }
        }
    }
}

@Composable
private fun PetsEditor(pets: List<PetForm>, errors: Map<String, FieldError>, onChange: (List<PetForm>) -> Unit) {
    val haptics = LocalHaptics.current
    // validation indexes pets without blank rows
    val validIndex = pets.indices.filter { pets[it].kind.isNotBlank() || pets[it].count.isNotBlank() }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        SectionTitle(stringResource(R.string.profile_f_pets))
        errors["household.pets"]?.let { Text(it.text(), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
        pets.forEachIndexed { i, p ->
            val vi = validIndex.indexOf(i)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.Top) {
                PField(p.kind, { v -> onChange(pets.toMutableList().also { it[i] = p.copy(kind = v) }) }, R.string.profile_f_pet_kind,
                    errors["household.pets.$vi.kind"], KeyboardType.Text, ImeAction.Next, modifier = Modifier.weight(2f))
                PField(p.count, { v -> onChange(pets.toMutableList().also { it[i] = p.copy(count = v.filter(Char::isDigit).take(2)) }) }, R.string.profile_f_pet_count,
                    errors["household.pets.$vi.count"], KeyboardType.Number, ImeAction.Next, modifier = Modifier.weight(1f))
                IconButton(
                    onClick = haptics.onClick(HapticEvent.LightTap) { onChange(pets.toMutableList().also { it.removeAt(i) }) },
                    modifier = Modifier.padding(top = 4.dp).heightIn(min = 48.dp),
                ) { Icon(Icons.Rounded.Close, contentDescription = stringResource(R.string.profile_remove_pet, i + 1)) }
            }
        }
        if (pets.size < ProfileRules.PETS_MAX) {
            OutlinedButton(
                onClick = haptics.onClick(HapticEvent.LightTap) { onChange(pets + PetForm()) },
                shapes = ButtonDefaults.shapes(),
                modifier = Modifier.heightIn(min = 48.dp),
            ) {
                Icon(Icons.Rounded.Add, null)
                Text(stringResource(R.string.profile_add_pet), modifier = Modifier.padding(start = 8.dp))
            }
        }
    }
}

/**
 * Height in centimetres or feet + inches with a segmented toggle. The form always stores centimetres (the API contract);
 * the ft/in boxes are display state and only write the form when the user types, so toggling never changes the stored value.
 */
@Composable
private fun HeightField(cmText: String, error: FieldError?, onCm: (String) -> Unit) {
    val haptics = LocalHaptics.current
    val system = com.beacon.mesh.ui.LocalUnitSystem.current
    var imperial by rememberSaveable { mutableStateOf(system == com.beacon.mesh.units.UnitSystem.IMPERIAL) }
    val initial = remember { com.beacon.mesh.ui.logic.HeightInput.fromCm(cmText) }
    var feet by rememberSaveable { mutableStateOf(initial.first) }
    var inches by rememberSaveable { mutableStateOf(initial.second) }
    // Form changed from outside (discard, reload): re-derive the boxes unless they already produce this value.
    androidx.compose.runtime.LaunchedEffect(cmText) {
        if (com.beacon.mesh.ui.logic.HeightInput.toCm(feet, inches) != cmText) {
            com.beacon.mesh.ui.logic.HeightInput.fromCm(cmText).let { feet = it.first; inches = it.second }
        }
    }
    val ftInvalid = imperial && cmText.isNotEmpty() && com.beacon.mesh.units.Units.parseHeightFeetInches(feet, inches) == null
    val label = stringResource(R.string.profile_f_height)
    val toggleLabel = stringResource(R.string.profile_height_unit_label)
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            SectionTitle(label, modifier = Modifier.weight(1f))
            Row(
                Modifier.semantics { contentDescription = toggleLabel },
                horizontalArrangement = Arrangement.spacedBy(androidx.compose.material3.ButtonGroupDefaults.ConnectedSpaceBetween),
            ) {
                listOf(false to R.string.profile_height_unit_cm, true to R.string.profile_height_unit_ftin).forEachIndexed { i, (isImperial, text) ->
                    androidx.compose.material3.ToggleButton(
                        checked = imperial == isImperial,
                        onCheckedChange = { if (imperial != isImperial) { haptics.perform(HapticEvent.Select); imperial = isImperial } },
                        modifier = Modifier.heightIn(min = 48.dp).semantics { role = androidx.compose.ui.semantics.Role.RadioButton },
                        shapes = if (i == 0) androidx.compose.material3.ButtonGroupDefaults.connectedLeadingButtonShapes()
                        else androidx.compose.material3.ButtonGroupDefaults.connectedTrailingButtonShapes(),
                    ) { Text(stringResource(text), maxLines = 1) }
                }
            }
        }
        if (!imperial) {
            PField(cmText, { v -> onCm(v.filter(Char::isDigit).take(3)) }, R.string.profile_f_height_cm, error, KeyboardType.Number, ImeAction.Next)
        } else {
            val ftError = if (ftInvalid || error != null) stringResource(R.string.profile_height_ftin_error) else null
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                PField(feet, { v -> feet = v.filter(Char::isDigit).take(1); onCm(com.beacon.mesh.ui.logic.HeightInput.toCm(feet, inches)) },
                    R.string.profile_f_height_feet, null, KeyboardType.Number, ImeAction.Next, modifier = Modifier.weight(1f),
                    errorOverride = if (ftError != null) " " else null)
                PField(inches, { v -> inches = v.filter(Char::isDigit).take(2); onCm(com.beacon.mesh.ui.logic.HeightInput.toCm(feet, inches)) },
                    R.string.profile_f_height_inches, null, KeyboardType.Number, ImeAction.Next, modifier = Modifier.weight(1f),
                    errorOverride = if (ftError != null) " " else null)
            }
            if (ftError != null) Text(ftError, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
        }
    }
}
