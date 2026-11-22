package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"math/big"
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
	power := new(big.Int)
	if exponent != "" {
		// The JSON decoder has already validated the exponent's syntax.
		power.SetString(exponent, 10)
	}
	power.Add(power, big.NewInt(int64(len(digits)-len(significant)-len(fraction))))
	if negative {
		significant = "-" + significant
	}
	return significant + "e" + power.String()
}
