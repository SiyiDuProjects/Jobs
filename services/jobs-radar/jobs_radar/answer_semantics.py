"""Public field shape bound into each server answer receipt."""
def field_key(field):
    return {key: field.get(key, '' if key == 'description' else None)
            for key in ('fieldId', 'question', 'type', 'required', 'description', 'options')}
