import 'package:flutter/material.dart';
import '../api.dart';
import '../calendar.dart';
import '../models.dart';
import 'basic_forms.dart';
import 'schedule_form.dart';
import 'shared.dart';

class MedicineDraft {
  MedicineDraft(this.start, {Medicine? replacement}) {
    name.text = replacement?.name ?? '';
    brand.text = replacement?.brand ?? '';
  }
  final name = TextEditingController(),
      brand = TextEditingController(),
      ingredient = TextEditingController(),
      strength = TextEditingController(),
      dose = TextEditingController(),
      frequency = TextEditingController();
  DateTime start;
  DateTime? end;
  final List<TimeOfDay> times = [];
  bool daily = true;
  final Set<int> days = {1, 2, 3, 4, 5};
  Json toJson({String? replaces}) => {
        'raw_text': name.text.trim(),
        'brand_name': brand.text.trim(),
        'ingredient': ingredient.text.trim(),
        'strength': strength.text.trim(),
        'dose_amount': dose.text.trim(),
        'frequency': frequency.text.trim(),
        'start_date': dateKey(start),
        'end_date': end == null ? null : dateKey(end!),
        if (replaces != null) 'replaces_item_id': replaces,
      };
  void dispose() {
    for (final c in [name, brand, ingredient, strength, dose, frequency]) {
      c.dispose();
    }
  }
}

class PrescriptionReceipt {
  const PrescriptionReceipt(this.message, this.needsAttention);
  final String message;
  final bool needsAttention;
}

Future<bool> recordPrescription(BuildContext context,
    {required Patient patient,
    required Repository repo,
    Medicine? replacement}) async {
  final receipt = await showDialog<PrescriptionReceipt>(
      context: context,
      barrierDismissible: false,
      builder: (_) => PrescriptionDialog(
          patient: patient, repo: repo, replacement: replacement));
  if (receipt == null || !context.mounted) return false;
  if (receipt.needsAttention) {
    await showDialog<void>(
        context: context,
        builder: (context) => AlertDialog(
                title: const Text('Prescription saved; check dose times'),
                content: Text(receipt.message),
                actions: [
                  FilledButton(
                      onPressed: () => Navigator.pop(context),
                      child: const Text('Got it'))
                ]));
  } else {
    notice(context, receipt.message);
  }
  return true;
}

class PrescriptionDialog extends StatefulWidget {
  const PrescriptionDialog(
      {super.key, required this.patient, required this.repo, this.replacement});
  final Patient patient;
  final Repository repo;
  final Medicine? replacement;
  @override
  State<PrescriptionDialog> createState() => _PrescriptionDialogState();
}

class _PrescriptionDialogState extends State<PrescriptionDialog> {
  final form = GlobalKey<FormState>();
  final notes = TextEditingController();
  final List<MedicineDraft> items = [];
  late DateTime visit;
  List<Doctor>? doctors;
  String? doctorId, error, loadError;
  bool busy = false;
  DateTime get today {
    final now = patientNow(widget.patient.timezone);
    return DateTime(now.year, now.month, now.day);
  }

  @override
  void initState() {
    super.initState();
    visit = today;
    items.add(MedicineDraft(today, replacement: widget.replacement));
    loadDoctors();
  }

  Future<void> loadDoctors() async {
    try {
      final result = await widget.repo.doctors(widget.patient.id);
      if (mounted) {
        setState(() {
          doctors = result;
          loadError = null;
        });
      }
    } catch (e) {
      if (mounted) setState(() => loadError = friendlyError(e));
    }
  }

  @override
  void dispose() {
    notes.dispose();
    for (final item in items) {
      item.dispose();
    }
    super.dispose();
  }

  Future<void> addDoctor() async {
    final result = await showDialog<bool>(
        context: context,
        barrierDismissible: false,
        builder: (_) =>
            DoctorDialog(repo: widget.repo, patient: widget.patient));
    if (result == true && mounted) await loadDoctors();
  }

  Future<void> addTime(MedicineDraft item) async {
    final result = await showTimePicker(
        context: context, initialTime: const TimeOfDay(hour: 8, minute: 0));
    if (result != null && mounted) {
      if (item.times
          .any((t) => t.hour == result.hour && t.minute == result.minute)) {
        notice(context, 'That time is already listed.');
        return;
      }
      setState(() {
        item.times.add(result);
        item.times.sort((a, b) =>
            (a.hour * 60 + a.minute).compareTo(b.hour * 60 + b.minute));
      });
    }
  }

  Future<void> save() async {
    if (!form.currentState!.validate()) return;
    for (final item in items) {
      if (item.end != null && item.end!.isBefore(item.start)) {
        setState(
            () => error = 'Each course must end on or after its start date.');
        return;
      }
      if (item.times.isNotEmpty && !item.daily && item.days.isEmpty) {
        setState(() => error = 'Choose at least one day for each dose time.');
        return;
      }
    }
    setState(() {
      busy = true;
      error = null;
    });
    try {
      final saved = await widget.repo.createPrescription(widget.patient.id, {
        'prescriber_id': doctorId,
        'visit_date': dateKey(visit),
        'notes': notes.text.trim(),
        'items': items
            .map((item) => item.toJson(replaces: widget.replacement?.id))
            .toList(),
      });
      if (!mounted) return;
      var failures = 0;
      // The prescription is already saved. Never retry creating it if a later
      // schedule fails; the medicine detail screen can finish any missing times.
      for (var i = 0; i < items.length; i++) {
        final item = items[i];
        for (final time in item.times) {
          try {
            await widget.repo
                .addSchedule(widget.patient.id, saved.items[i].id, {
              'time_of_day':
                  '${time.hour.toString().padLeft(2, '0')}:${time.minute.toString().padLeft(2, '0')}',
              'days_of_week':
                  item.daily ? <int>[] : (item.days.toList()..sort()),
              'start_date': dateKey(item.start),
              'end_date': item.end == null ? null : dateKey(item.end!),
            });
          } catch (_) {
            failures++;
          }
        }
      }
      String message = failures == 0
          ? 'Prescription saved.'
          : 'Prescription saved. $failures dose ${failures == 1 ? 'time needs' : 'times need'} attention. Open each medicine to finish its schedule.';
      var warning = failures > 0;
      try {
        await widget.repo.generateDoses(widget.patient.id);
      } catch (_) {
        warning = true;
        message += ' Refresh the timeline when the connection returns.';
      }
      if (mounted) {
        Navigator.pop(context, PrescriptionReceipt(message, warning));
      }
    } catch (e) {
      if (mounted) setState(() => error = friendlyError(e));
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => FormDialog(
          title: widget.replacement == null
              ? 'Add a prescription'
              : 'Record a replacement',
          subtitle: widget.replacement == null
              ? 'Enter the instructions from the prescription. Add dose times when known.'
              : 'Use the new prescription’s instructions. Previous records will be kept.',
          formKey: form,
          busy: busy,
          error: error,
          onSave: save,
          saveLabel: 'Save prescription',
          children: [
            if (doctors == null) ...[
              if (loadError == null)
                const LinearProgressIndicator()
              else
                Text(loadError!,
                    style:
                        TextStyle(color: Theme.of(context).colorScheme.error)),
              if (loadError != null)
                TextButton(
                    onPressed: loadDoctors,
                    child: const Text('Retry loading doctors')),
            ] else
              DropdownButtonFormField<String>(
                  value: doctorId,
                  isExpanded: true,
                  decoration:
                      const InputDecoration(labelText: 'Prescribing doctor'),
                  items: [
                    const DropdownMenuItem<String>(
                        value: null, child: Text('Doctor not recorded')),
                    for (final doctor in doctors!)
                      DropdownMenuItem(
                          value: doctor.id,
                          child: Text(doctor.name,
                              overflow: TextOverflow.ellipsis))
                  ],
                  onChanged: (value) => setState(() => doctorId = value)),
            Align(
                alignment: Alignment.centerLeft,
                child: TextButton.icon(
                    onPressed: addDoctor,
                    icon: const Icon(Icons.add, size: 18),
                    label: const Text('Add a doctor'))),
            DateField(
                label: 'Visit date',
                value: visit,
                clearable: false,
                onChanged: (value) => setState(() => visit = value!)),
            for (var index = 0; index < items.length; index++)
              medicineFields(items[index], index),
            if (widget.replacement == null && items.length < 100)
              OutlinedButton.icon(
                  onPressed: () =>
                      setState(() => items.add(MedicineDraft(today))),
                  icon: const Icon(Icons.add),
                  label: const Text('Add another medicine')),
            TextFormField(
                controller: notes,
                maxLines: 3,
                maxLength: 5000,
                decoration:
                    const InputDecoration(labelText: 'Visit notes (optional)')),
          ]);

  Widget medicineFields(MedicineDraft item, int index) => Panel(
      key: ObjectKey(item),
      padding: const EdgeInsets.all(16),
      color: const Color(0xFFFAFBF8),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Row(children: [
          Text('Medicine ${index + 1}',
              style: Theme.of(context).textTheme.titleMedium),
          const Spacer(),
          if (items.length > 1)
            IconButton(
                tooltip: 'Remove medicine ${index + 1}',
                onPressed: () => setState(() {
                      items.remove(item);
                      item.dispose();
                    }),
                icon: const Icon(Icons.close, size: 20))
        ]),
        const SizedBox(height: 14),
        TextFormField(
            controller: item.name,
            maxLength: 500,
            decoration: const InputDecoration(labelText: 'Medicine as written'),
            validator: requiredText),
        const SizedBox(height: 12),
        TextFormField(
            controller: item.dose,
            maxLength: 100,
            decoration: const InputDecoration(
                labelText: 'Dose as prescribed',
                hintText: 'Copy the dose from the prescription'),
            validator: requiredText),
        const SizedBox(height: 12),
        TextFormField(
            controller: item.frequency,
            maxLength: 200,
            decoration: const InputDecoration(
                labelText: 'Frequency as written (optional)')),
        const SizedBox(height: 12),
        DateField(
            label: 'Course starts',
            value: item.start,
            clearable: false,
            first: widget.replacement == null ? null : today,
            onChanged: (value) => setState(() => item.start = value!)),
        const SizedBox(height: 16),
        DateField(
            label: 'Course ends (optional)',
            value: item.end,
            first: item.start,
            onChanged: (value) => setState(() => item.end = value)),
        const SizedBox(height: 12),
        ExpansionTile(
            tilePadding: EdgeInsets.zero,
            title: const Text('Brand, ingredient and strength'),
            childrenPadding: const EdgeInsets.only(bottom: 14),
            children: [
              TextFormField(
                  controller: item.brand,
                  maxLength: 500,
                  decoration:
                      const InputDecoration(labelText: 'Brand (if known)')),
              const SizedBox(height: 12),
              TextFormField(
                  controller: item.ingredient,
                  maxLength: 500,
                  decoration: const InputDecoration(
                      labelText: 'Ingredient (if known)')),
              const SizedBox(height: 12),
              TextFormField(
                  controller: item.strength,
                  maxLength: 100,
                  decoration:
                      const InputDecoration(labelText: 'Strength as written')),
            ]),
        const SizedBox(height: 10),
        Wrap(spacing: 8, runSpacing: 8, children: [
          for (final time in item.times)
            InputChip(
                label: Text(time.format(context)),
                onDeleted: () => setState(() => item.times.remove(time))),
          ActionChip(
              avatar: const Icon(Icons.add, size: 18),
              label: const Text('Add dose time'),
              onPressed: () => addTime(item)),
        ]),
        if (item.times.isNotEmpty) ...[
          const SizedBox(height: 12),
          WeekdayPicker(
              daily: item.daily,
              days: item.days,
              onDaily: (value) => setState(() => item.daily = value),
              onDay: (day, selected) => setState(() {
                    selected ? item.days.add(day) : item.days.remove(day);
                  }))
        ],
      ]));
}
