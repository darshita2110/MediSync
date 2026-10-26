import 'package:flutter/material.dart';
import 'package:timezone/timezone.dart' as tz;
import '../api.dart';
import '../calendar.dart';
import '../models.dart';
import 'shared.dart';

class NewPatientDialog extends StatefulWidget {
  const NewPatientDialog({super.key, required this.repo});
  final Repository repo;
  @override
  State<NewPatientDialog> createState() => _NewPatientDialogState();
}

class _NewPatientDialogState extends State<NewPatientDialog> {
  final form = GlobalKey<FormState>();
  final name = TextEditingController();
  String timezone = 'Asia/Kolkata';
  DateTime? birth;
  bool busy = false;
  String? error;
  @override
  void dispose() {
    name.dispose();
    super.dispose();
  }

  Future<void> save() async {
    if (!form.currentState!.validate()) return;
    setState(() {
      busy = true;
      error = null;
    });
    try {
      await widget.repo.createPatient({
        'full_name': name.text.trim(),
        'timezone': timezone,
        'date_of_birth': birth == null ? null : dateKey(birth!)
      });
      if (mounted) Navigator.pop(context, true);
    } catch (e) {
      if (mounted) setState(() => error = friendlyError(e));
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => FormDialog(
          title: 'Add a patient',
          subtitle:
              'Who are you coordinating care for? You will own this care space and can invite others.',
          formKey: form,
          busy: busy,
          error: error,
          onSave: save,
          saveLabel: 'Create care space',
          children: [
            TextFormField(
                controller: name,
                decoration: const InputDecoration(labelText: 'Patient name'),
                validator: requiredText,
                textCapitalization: TextCapitalization.words,
                maxLength: 200),
            Autocomplete<String>(
                initialValue: const TextEditingValue(text: 'Asia/Kolkata'),
                optionsBuilder: (value) => tz.timeZoneDatabase.locations.keys
                    .where((name) => name
                        .toLowerCase()
                        .replaceAll('_', ' ')
                        .contains(
                            value.text.toLowerCase().replaceAll('_', ' ')))
                    .take(12),
                onSelected: (value) => timezone = value,
                fieldViewBuilder: (context, controller, focus, onSubmitted) =>
                    TextFormField(
                        controller: controller,
                        focusNode: focus,
                        onChanged: (value) => timezone = value.trim(),
                        decoration: const InputDecoration(
                            labelText: 'Patient time zone',
                            helperText:
                                'Search a city, for example Kolkata. Dose times follow this location.'),
                        validator: (value) {
                          try {
                            tz.getLocation(value!.trim());
                            return null;
                          } catch (_) {
                            return 'Select a valid time zone';
                          }
                        })),
            DateField(
                label: 'Date of birth (optional)',
                value: birth,
                last: DateTime.now(),
                onChanged: (value) => setState(() => birth = value)),
          ]);
}

class DoctorDialog extends StatefulWidget {
  const DoctorDialog({super.key, required this.repo, required this.patient});
  final Repository repo;
  final Patient patient;
  @override
  State<DoctorDialog> createState() => _DoctorDialogState();
}

class _DoctorDialogState extends State<DoctorDialog> {
  final form = GlobalKey<FormState>();
  final name = TextEditingController(),
      specialty = TextEditingController(),
      clinic = TextEditingController(),
      phone = TextEditingController();
  bool busy = false;
  String? error;
  @override
  void dispose() {
    for (final c in [name, specialty, clinic, phone]) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> save() async {
    if (!form.currentState!.validate()) return;
    setState(() {
      busy = true;
      error = null;
    });
    try {
      await widget.repo.addDoctor(widget.patient.id, {
        'name': name.text.trim(),
        'specialty': specialty.text.trim(),
        'clinic': clinic.text.trim(),
        'phone': phone.text.trim()
      });
      if (mounted) Navigator.pop(context, true);
    } catch (e) {
      if (mounted) setState(() => error = friendlyError(e));
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => FormDialog(
          title: 'Add a doctor',
          formKey: form,
          busy: busy,
          error: error,
          onSave: save,
          children: [
            TextFormField(
                controller: name,
                decoration: const InputDecoration(labelText: 'Doctor name'),
                validator: requiredText,
                textCapitalization: TextCapitalization.words,
                maxLength: 200),
            TextFormField(
                controller: specialty,
                decoration:
                    const InputDecoration(labelText: 'Specialty (optional)'),
                maxLength: 200),
            TextFormField(
                controller: clinic,
                decoration:
                    const InputDecoration(labelText: 'Clinic (optional)'),
                maxLength: 200),
            TextFormField(
                controller: phone,
                decoration:
                    const InputDecoration(labelText: 'Phone (optional)'),
                keyboardType: TextInputType.phone,
                maxLength: 50),
          ]);
}
