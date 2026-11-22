package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"
)

const maxRequestBytes = 4 << 20

func decodeRequest[T any](w http.ResponseWriter, r *http.Request) (T, error) {
	var value T
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxRequestBytes))
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		return value, &apiError{http.StatusRequestEntityTooLarge, "body_too_large", "request body exceeds 4 MiB"}
	}
	if err != nil || !utf8.Valid(data) {
		return value, invalidRequest("request must be a valid JSON object")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var decoded *T
	if err := decoder.Decode(&decoded); err != nil || decoded == nil || decoder.Decode(new(json.RawMessage)) != io.EOF {
		return value, invalidRequest("request must be one JSON object with the expected fields")
	}
	return *decoded, nil
}

func invalidRequest(message string) *apiError {
	return &apiError{http.StatusBadRequest, "invalid_request", message}
}

func canonicalObject(raw json.RawMessage, name string) (json.RawMessage, error) {
	if len(raw) == 0 || raw[0] != '{' {
		return nil, invalidRequest(name + " must be a JSON object")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value map[string]any
	if err := decoder.Decode(&value); err != nil {
		return nil, invalidRequest(name + " must be a JSON object")
	}
	return json.Marshal(canonicalValue(value))
}

// Store the original JSON separately. Quote strings and encode numbers without
// expanding exponents so PostgreSQL can compare values outside jsonb's native range.
func canonicalValue(value any) any {
	switch value := value.(type) {
	case map[string]any:
		object := make(map[string]any, len(value))
		for key, field := range value {
			object[strconv.Quote(key)] = canonicalValue(field)
		}
		return object
	case []any:
		for i, element := range value {
			value[i] = canonicalValue(element)
		}
		return value
	case string:
		return strconv.Quote(value)
	case json.Number:
		return canonicalNumber(string(value))
	default:
		return value
	}
}

func canonicalNumber(number string) string {
	negative := strings.HasPrefix(number, "-")
	unsigned := strings.TrimPrefix(number, "-")
	mantissa, exponent, _ := strings.Cut(strings.ReplaceAll(unsigned, "E", "e"), "e")
	whole, fraction, _ := strings.Cut(mantissa, ".")
	digits := strings.TrimLeft(whole+fraction, "0")
	if digits == "" {
		return "0"
	}
	significant := strings.TrimRight(digits, "0")
	power := shiftExponent(exponent, len(digits)-len(significant)-len(fraction))
	if negative {
		significant = "-" + significant
	}
	return significant + "e" + power
}

// Exponents can be as long as the input. Adjust their decimal digits directly
// so normalization stays linear and does not expand the represented number.
func shiftExponent(exponent string, offset int) string {
	negative := strings.HasPrefix(exponent, "-")
	digits := strings.TrimLeft(exponent, "+-0")
	if len(digits) <= 9 {
		value, _ := strconv.Atoi(digits)
		if negative {
			value = -value
		}
		return strconv.Itoa(value + offset)
	}

	// The mantissa offset is bounded by the request size, so it cannot change this sign.
	if negative {
		offset = -offset
	}
	adjusted := []byte(digits)
	for i := len(adjusted) - 1; i >= 0 && offset != 0; i-- {
		value := int(adjusted[i]-'0') + offset
		digit := value % 10
		offset = value / 10
		if digit < 0 {
			digit += 10
			offset--
		}
		adjusted[i] = byte(digit) + '0'
	}

	result := string(adjusted)
	if offset > 0 {
		result = "1" + result
	} else {
		result = strings.TrimLeft(result, "0")
	}
	if negative {
		return "-" + result
	}
	return result
}
